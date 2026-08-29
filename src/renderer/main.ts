import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { latex } from 'codemirror-lang-latex';
import * as pdfjsLib from 'pdfjs-dist';
import { collab, setupCollab, isCollabActive, getCollabExtensions, getDocContent, flushCollabSave, handleSourceChanged, startHost, joinRoom } from './collab';

// Set worker path — copied from node_modules during build
pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';

// ─── Global State ───────────────────────────────────────────────

const appState = {
  currentFilePath: null,
  content: '',
  modified: false,
  zoom: 1,
  pageNum: 1,
  totalPages: 0,
  pdfDoc: null,
  compiling: false,
  exporting: false,
  compileTimer: null,
  settings: {
    engine: 'xelatex',
    enginePath: '',
    editorFont: 'Consolas',
    editorFontSize: 14,
    theme: 'light',
    debounceMs: 800,
  },
};

// ─── DOM References ─────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const editorContainer = $('editor-container');
const viewerContainer = $('viewer-container');
const canvas = $('pdf-canvas');
const ctx = canvas.getContext('2d');
const zoomLevel = $('zoom-level');
const pageInfo = $('page-info');
const filePathEl = $('file-path');
const modifiedIndicator = $('modified-indicator');
const compileStatus = $('compile-status');
const compileTimer = $('compile-timer');
const errorPanel = $('error-panel');
const errorList = $('error-list');
const currentFileEl = $('current-file');
const settingsModal = $('settings-modal');

// ─── Editor ─────────────────────────────────────────────────────

let editor = null;

function createEditor() {
  const darkTheme = appState.settings.theme === 'dark' ? EditorView.theme({
    '&': { backgroundColor: '#1e1e1e', color: '#d4d4d4' },
    '.cm-content': { caretColor: '#fff' },
    '.cm-cursor': { borderLeftColor: '#fff' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: '#264f78' },
    '.cm-activeLine': { backgroundColor: '#2a2d2e' },
    '.cm-gutters': { backgroundColor: '#252526', color: '#858585', borderRight: '1px solid #333' },
    '.cm-activeLineGutter': { backgroundColor: '#2a2d2e', color: '#c6c6c6' },
  }) : [];

  const state = EditorState.create({
    doc: '',
    extensions: [
      basicSetup,
      latex(),
      ...darkTheme,
      EditorView.theme({
        '&': { fontFamily: `${appState.settings.editorFont || 'Consolas'}, monospace`, fontSize: `${appState.settings.editorFontSize || 14}px` },
      }),
      // CRDT binding replaces the plain doc when a collab session is live;
      // yCollab provides its own undo history + remote cursors/selections
      ...(isCollabActive() ? getCollabExtensions() : []),
      keymap.of([
        { key: 'Mod-s', run: () => { if (isCollabActive()) { flushCollabSave(); compileStatus.textContent = '协作模式自动保存 ✓'; compileStatus.className = 'status-success'; } else saveFile(); return true; } },
        { key: 'Mod-Shift-s', run: () => { if (!isCollabActive()) saveAsFile(); return true; } },
        { key: 'Mod-o', run: () => { if (!isCollabActive()) openFile(); return true; } },
        { key: 'Mod-n', run: () => { if (!isCollabActive()) newFile(); return true; } },
        { key: 'Mod-Enter', run: () => { manualCompile(); return true; } },
      ]),
      // Use standard updateListener instead of custom dispatch override
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          appState.content = update.state.doc.toString();
          appState.modified = true;
          updateModified();
          scheduleCompile();
        }
      }),
    ],
  });

  editor = new EditorView({
    state,
    parent: editorContainer,
  });
}

// Re-entering collab mode swaps the editor between a plain local doc and the
// CRDT-bound one — recreate from scratch either way.
function rebuildEditor() {
  if (editor) editor.destroy();
  createEditor();
}

function updatePathUI(filePath) {
  filePathEl.textContent = filePath;
  currentFileEl.textContent = filePath.split(/[/\\]/).pop();
}

function setEditorContent(content) {
  if (!editor) return;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: content },
  });
  appState.modified = false;
  updateModified();
}

function scrollEditorToLine(line) {
  if (!editor) return;
  const linePos = editor.state.doc.line(line);
  editor.dispatch({ selection: { anchor: linePos.from }, scrollIntoView: true });
  editor.focus();
}

// ─── PDF Viewer ────────────────────────────────────────────────

let renderTask = null;
let currentScale = 1;

async function renderPdfPage(pdfDoc, pageNum, scale) {
  // Cancel any in-flight render, then start fresh (race-safe)
  if (renderTask) { try { renderTask.cancel(); } catch {} renderTask = null; }
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  renderTask = page.render({ canvasContext: ctx, viewport });
  try {
    await renderTask.promise;
  } catch (e) {
    // RenderingCancelledException or other — ignore, a newer render is on the way
  } finally {
    renderTask = null;
  }
}

async function loadPdf(pdfPath) {
  try {
    const p = await window.api.file.readPdf(pdfPath);
    if (!p) { console.error('PDF not found:', pdfPath); return false; }
    // base64 → binary → Blob → object URL
    const bin = atob(p.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const pdfDoc = await pdfjsLib.getDocument(url).promise;
    URL.revokeObjectURL(url);
    const isNewDoc = !appState.pdfDoc;
    appState.pdfDoc = pdfDoc;
    appState.totalPages = pdfDoc.numPages;
    appState.pageNum = Math.min(appState.pageNum, appState.totalPages);
    pageInfo.textContent = appState.totalPages ? `${appState.pageNum} / ${appState.totalPages}` : '— / —';
    if (isNewDoc) {
      // Fit a newly opened document to the panel width (the canvas no longer
      // auto-shrinks to fit, so 100% could overflow with scrollbars)
      const page = await pdfDoc.getPage(appState.pageNum);
      const w = viewerContainer.clientWidth - 16;
      if (w > 0) {
        currentScale = w / page.getViewport({ scale: 1 }).width;
        zoomLevel.textContent = `${Math.round(currentScale * 100)}%`;
      }
    }
    await renderPdfPage(pdfDoc, appState.pageNum, currentScale);
    return true;
  } catch (e) {
    console.error('PDF load error:', e);
    appState.pdfDoc = null;
    appState.totalPages = 0;
    pageInfo.textContent = '— / —';
    return false;
  }
}

// ─── Compilation ────────────────────────────────────────────────

// Fill the error panel from a compile result (structured errors, or log tail)
function showResultErrors(result) {
  errorList.innerHTML = '';
  document.querySelectorAll('.error-line').forEach(el => el.classList.remove('error-line'));
  errorPanel.classList.remove('hidden');
  if (result.errors && result.errors.length > 0) {
    result.errors.forEach((err) => {
      const el = document.createElement('div');
      el.className = 'error-item';
      el.title = err.line ? `行 ${err.line}: ${err.message}` : err.message;
      el.textContent = err.line ? `行 ${err.line}: ${err.message}` : err.message;
      el.addEventListener('click', () => { if (err.line) scrollEditorToLine(err.line); });
      errorList.appendChild(el);
    });
  } else if (result.log) {
    const lines = result.log.split('\n').filter(l => l.trim()).slice(-15);
    lines.forEach(line => {
      const el = document.createElement('div');
      el.className = 'error-item';
      el.textContent = line.slice(0, 120);
      el.title = line;
      errorList.appendChild(el);
    });
  } else {
    const el = document.createElement('div');
    el.className = 'error-item';
    el.textContent = '编译工具无输出，请检查设置中的编译器路径';
    errorList.appendChild(el);
  }
}

async function runCompile() {
  if (appState.compiling || !appState.currentFilePath) return;
  // Guest entering a room: editor may still be waiting for the first CRDT
  // sync — compiling the transient empty doc would just flash error noise.
  if (isCollabActive() && !collab.syncedOnce) {
    compileStatus.textContent = '等待内容同步…';
    compileStatus.className = 'status-running';
    setTimeout(runCompile, 300);
    return;
  }
  appState.compiling = true;
  compileStatus.textContent = '编译中...';
  compileStatus.className = 'status-running';
  compileTimer.textContent = '';
  compileTimer.classList.remove('hidden');

  const startTime = Date.now();
  const timerInterval = setInterval(() => {
    compileTimer.textContent = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  }, 100);

  try {
    // Preview mode: compile a temp copy of the project with current editor content.
    // The original file is NOT written (only Ctrl+S does that).
    const result = await window.api.compiler.preview(appState.currentFilePath, editor.state.doc.toString());
    clearInterval(timerInterval);
    compileTimer.textContent = `${(result.elapsed / 1000).toFixed(1)}s`;

    errorList.innerHTML = '';
    document.querySelectorAll('.error-line').forEach(el => el.classList.remove('error-line'));

    if (result.errors && result.errors.length > 0) {
      compileStatus.textContent = '编译错误';
      compileStatus.className = 'status-error';
      compileStatus.title = `${result.errors.length} 个错误`;
      showResultErrors(result);
    } else if (result.success) {
      compileStatus.textContent = '编译成功 ✓';
      compileStatus.className = 'status-success';
      compileStatus.title = `${(result.elapsed / 1000).toFixed(1)}s`;
      errorPanel.classList.add('hidden');
      if (result.pdfPath) {
        console.log("PDF loading via IPC")
        await loadPdf(result.pdfPath);
        await window.api.watcher.watchPdf(result.pdfPath);
      }
    } else {
      compileStatus.textContent = '编译失败';
      compileStatus.className = 'status-error';
      compileStatus.title = '编译失败，查看下方错误日志';
      showResultErrors(result);
    }
  } catch (e) {
    clearInterval(timerInterval);
    compileStatus.textContent = '编译异常';
    compileStatus.className = 'status-error';
    compileStatus.title = e?.message || String(e);

    // Show error in the error panel
    errorList.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'error-item';
    el.textContent = `系统错误: ${e?.message || e}`;
    if (e?.stack) el.title = e.stack;
    errorList.appendChild(el);
    errorPanel.classList.remove('hidden');

    console.error('[LiveLaTeX] Compile exception:', e);
  }
  appState.compiling = false;
}

let debounceTimer = null;

function scheduleCompile() {
  if (!appState.currentFilePath) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(runCompile, appState.settings.debounceMs || 800);
}

function manualCompile() {
  if (debounceTimer) clearTimeout(debounceTimer);
  runCompile();
}

// Full compile (all passes + bibliography) → save the PDF to a user-chosen location
async function exportPdf() {
  if (!appState.currentFilePath) {
    compileStatus.textContent = '请先打开 .tex 文件';
    compileStatus.className = 'status-error';
    return;
  }
  if (appState.compiling || appState.exporting) return;
  appState.exporting = true;
  $('btn-export').disabled = true;

  compileStatus.textContent = '全量编译中...';
  compileStatus.className = 'status-running';
  compileTimer.textContent = '';
  compileTimer.classList.remove('hidden');
  const startTime = Date.now();
  const timerInterval = setInterval(() => {
    compileTimer.textContent = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  }, 100);

  try {
    const result = await window.api.compiler.export(appState.currentFilePath, editor.state.doc.toString());
    clearInterval(timerInterval);
    compileTimer.textContent = `${(result.elapsed / 1000).toFixed(1)}s`;

    if (result.savedPath) {
      compileStatus.textContent = '已导出 ✓';
      compileStatus.className = 'status-success';
      compileStatus.title = result.savedPath;
      errorPanel.classList.add('hidden');
    } else if (result.canceled) {
      compileStatus.textContent = '编译成功 ✓ (未保存)';
      compileStatus.className = 'status-success';
      compileStatus.title = '已取消保存，PDF 仍在预览中';
    } else {
      compileStatus.textContent = '导出失败';
      compileStatus.className = 'status-error';
      showResultErrors(result);
    }
  } catch (e) {
    clearInterval(timerInterval);
    compileStatus.textContent = '导出异常';
    compileStatus.className = 'status-error';
    compileStatus.title = e?.message || String(e);
    showResultErrors({ errors: [{ message: `系统错误: ${e?.message || e}`, line: null }], log: '' });
    console.error('[LiveLaTeX] Export exception:', e);
  }
  $('btn-export').disabled = false;
  appState.exporting = false;
}

// ─── File Operations ────────────────────────────────────────────

async function newFile() {
  if (isCollabActive()) { collabStatusMsg('协作模式下不能新建文件，请先退出协作'); return; }
  appState.currentFilePath = null;
  setEditorContent('');
  filePathEl.textContent = '未命名';
  currentFileEl.textContent = '未命名';
  errorPanel.classList.add('hidden');
  await window.api.watcher.unwatch();
  await window.api.watcher.unwatchSource();
  appState.pdfDoc = null;
  appState.totalPages = 0;
  pageInfo.textContent = '— / —';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

async function openFile() {
  if (isCollabActive()) { collabStatusMsg('协作模式下不能打开其他文件，请先退出协作'); return; }
  console.log('[LiveLaTeX] openFile called');
  try {
    const result = await window.api.file.open();
    console.log('[LiveLaTeX] openFile result:', result ? `file=${result.filePath}` : 'null (canceled)');
    if (!result) return;
    appState.currentFilePath = result.filePath;
    setEditorContent(result.content);
    updatePathUI(result.filePath);
    window.api.watcher.watchSource(result.filePath);
    errorPanel.classList.add('hidden');
    runCompile();
  } catch (err) {
    console.error('[LiveLaTeX] openFile error:', err);
    compileStatus.textContent = '打开文件失败';
    compileStatus.className = 'status-error';
  }
}

async function saveFile() {
  if (isCollabActive()) { flushCollabSave(); return; }
  const content = editor.state.doc.toString();
  if (appState.currentFilePath) {
    const result = await window.api.file.save(content, appState.currentFilePath);
    if (result && result.saved) {
      appState.modified = false;
      updateModified();
    }
  } else {
    saveAsFile();
  }
}

async function saveAsFile() {
  if (isCollabActive()) { collabStatusMsg('协作模式下不能另存，请先退出协作'); return; }
  const content = editor.state.doc.toString();
  const result = await window.api.file.saveAs(content);
  if (result && result.saved) {
    appState.currentFilePath = result.filePath;
    updatePathUI(result.filePath);
    window.api.watcher.watchSource(result.filePath);
    appState.modified = false;
    updateModified();
  }
}

function updateModified() {
  modifiedIndicator.textContent = appState.modified ? '● 未保存' : '';
}

function collabStatusMsg(msg) {
  compileStatus.textContent = msg;
  compileStatus.className = 'status-error';
}

// ─── SyncTeX ────────────────────────────────────────────────────

let synctexEnabled = false;
const synctexBtn = $('btn-synctex');

function toggleSynctex() {
  synctexEnabled = !synctexEnabled;
  synctexBtn.style.background = synctexEnabled ? 'var(--accent)' : '';
  synctexBtn.style.color = synctexEnabled ? 'white' : '';
}

function handleClickOnEditor() {
  if (!synctexEnabled || !editor || !appState.currentFilePath) return;
  const pos = editor.state.selection.main.head;
  const line = editor.state.doc.lineAt(pos);
  window.api.synctex.forward(line.number, pos - line.from, appState.currentFilePath).then(result => {
    if (result && appState.pdfDoc) {
      appState.pageNum = result.page;
      renderPdfPage(appState.pdfDoc, result.page, currentScale);
      pageInfo.textContent = `${result.page} / ${appState.totalPages}`;
    }
  });
}

// ─── Settings ───────────────────────────────────────────────────

async function loadSettings() {
  const s = await window.api.settings.get();
  if (!s) return;
  Object.assign(appState.settings, s);
  $('setting-engine').value = s.engine || 'xelatex';
  $('setting-engine-path').value = s.enginePath || '';
  $('setting-editor-font').value = s.editorFont || 'Consolas';
  $('setting-editor-font-size').value = s.editorFontSize || 14;
  $('setting-debounce').value = s.debounceMs || 800;
  $('setting-theme').value = s.theme || 'light';
  applyTheme(s.theme || 'light');
}

async function saveSettings() {
  const engine = $('setting-engine').value;
  const enginePath = $('setting-engine-path').value;
  const editorFont = $('setting-editor-font').value;
  const editorFontSize = parseInt($('setting-editor-font-size').value) || 14;
  const debounceMs = parseInt($('setting-debounce').value) || 800;
  const theme = $('setting-theme').value;

  await window.api.settings.set('engine', engine);
  await window.api.settings.set('enginePath', enginePath);
  await window.api.settings.set('editorFont', editorFont);
  await window.api.settings.set('editorFontSize', editorFontSize);
  await window.api.settings.set('debounceMs', debounceMs);
  await window.api.settings.set('theme', theme);

  appState.settings = { engine, enginePath, editorFont, editorFontSize, debounceMs, theme };
  applyTheme(theme);
  closeSettings();
}

function applyTheme(theme) {
  document.body.classList.toggle('dark', theme === 'dark');
}

function openSettings() { settingsModal.classList.remove('hidden'); }
function closeSettings() { settingsModal.classList.add('hidden'); }

// ─── Event Listeners ────────────────────────────────────────────

function setupListeners() {
  // File
  $('btn-new').addEventListener('click', newFile);
  $('btn-open').addEventListener('click', openFile);
  $('btn-save').addEventListener('click', saveFile);
  $('btn-save-as').addEventListener('click', saveAsFile);
  $('btn-compile').addEventListener('click', manualCompile);
  $('btn-export').addEventListener('click', exportPdf);
  synctexBtn.addEventListener('click', toggleSynctex);

  // Zoom
  $('btn-zoom-in').addEventListener('click', async () => {
    currentScale = Math.min(currentScale * 1.2, 5);
    zoomLevel.textContent = `${Math.round(currentScale * 100)}%`;
    if (appState.pdfDoc) await renderPdfPage(appState.pdfDoc, appState.pageNum, currentScale);
  });
  $('btn-zoom-out').addEventListener('click', async () => {
    currentScale = Math.max(currentScale * 0.8, 0.2);
    zoomLevel.textContent = `${Math.round(currentScale * 100)}%`;
    if (appState.pdfDoc) await renderPdfPage(appState.pdfDoc, appState.pageNum, currentScale);
  });
  $('btn-fit-width').addEventListener('click', async () => {
    if (!appState.pdfDoc) return;
    const w = viewerContainer.clientWidth - 16;
    const page = await appState.pdfDoc.getPage(appState.pageNum);
    currentScale = w / page.getViewport({ scale: 1 }).width;
    zoomLevel.textContent = `${Math.round(currentScale * 100)}%`;
    renderPdfPage(appState.pdfDoc, appState.pageNum, currentScale);
  });
  $('btn-fit-page').addEventListener('click', async () => {
    if (!appState.pdfDoc) return;
    const h = viewerContainer.clientHeight - 16;
    const page = await appState.pdfDoc.getPage(appState.pageNum);
    currentScale = h / page.getViewport({ scale: 1 }).height;
    zoomLevel.textContent = `${Math.round(currentScale * 100)}%`;
    renderPdfPage(appState.pdfDoc, appState.pageNum, currentScale);
  });

  // Settings
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-settings-save').addEventListener('click', saveSettings);
  $('btn-settings-cancel').addEventListener('click', closeSettings);
  document.querySelector('.modal-backdrop').addEventListener('click', closeSettings);
  document.querySelector('.modal-close').addEventListener('click', closeSettings);
  $('error-close').addEventListener('click', () => errorPanel.classList.add('hidden'));
  $('btn-detect-engine').addEventListener('click', async () => {
    const engines = await window.api.compiler.detect();
    const el = $('detect-result');
    el.classList.remove('hidden');
    if (engines && engines.length > 0) {
      el.textContent = `已找到: ${engines.join(', ')}`;
      el.style.color = 'var(--success)';
    } else {
      el.textContent = '未检测到 LaTeX 编译器。请安装 TeX Live/MiKTeX 后在设置中配置路径。';
      el.style.color = 'var(--error)';
    }
  });

  // Viewer page nav via scroll
  viewerContainer.addEventListener('wheel', async (e) => {
    if (!appState.pdfDoc || e.ctrlKey) return;
    if (e.deltaY > 50 && appState.pageNum < appState.totalPages) {
      appState.pageNum++;
      await renderPdfPage(appState.pdfDoc, appState.pageNum, currentScale);
      pageInfo.textContent = `${appState.pageNum} / ${appState.totalPages}`;
    } else if (e.deltaY < -50 && appState.pageNum > 1) {
      appState.pageNum--;
      await renderPdfPage(appState.pdfDoc, appState.pageNum, currentScale);
      pageInfo.textContent = `${appState.pageNum} / ${appState.totalPages}`;
    }
  });

  // Synctex: click on canvas
  canvas.addEventListener('click', async (e) => {
    if (!synctexEnabled || !appState.pdfDoc || !appState.currentFilePath) return;
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / currentScale;
    const y = (e.clientY - rect.top) / currentScale;
    const result = await window.api.synctex.backward(appState.pageNum, x, y, appState.currentFilePath);
    if (result && result.line) scrollEditorToLine(result.line);
  });

  // Synctex: click on editor
  editorContainer.addEventListener('mouseup', (e) => {
    if (!synctexEnabled || e.button !== 0) return;
    setTimeout(handleClickOnEditor, 30);
  });

  // Divider resize
  const divider = $('divider');
  let dragging = false;
  divider.addEventListener('mousedown', () => {
    dragging = true;
    divider.classList.add('active');
    document.body.style.cursor = 'col-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const pct = Math.max(20, Math.min(80, (e.clientX / document.getElementById('main').clientWidth) * 100));
    $('editor-panel').style.width = `${pct}%`;
    $('viewer-panel').style.width = `${100 - pct}%`;
  });
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      divider.classList.remove('active');
      document.body.style.cursor = '';
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey) {
      if (e.key === '=' || e.key === '+') { e.preventDefault(); $('btn-zoom-in').click(); }
      if (e.key === '-') { e.preventDefault(); $('btn-zoom-out').click(); }
      if (e.key === '0') { e.preventDefault(); currentScale = 1; zoomLevel.textContent = '100%'; if (appState.pdfDoc) renderPdfPage(appState.pdfDoc, appState.pageNum, 1); }
    }
    if (e.key === 'PageDown' && appState.pdfDoc && appState.pageNum < appState.totalPages) {
      e.preventDefault(); appState.pageNum++;
      renderPdfPage(appState.pdfDoc, appState.pageNum, currentScale);
      pageInfo.textContent = `${appState.pageNum} / ${appState.totalPages}`;
    }
    if (e.key === 'PageUp' && appState.pdfDoc && appState.pageNum > 1) {
      e.preventDefault(); appState.pageNum--;
      renderPdfPage(appState.pdfDoc, appState.pageNum, currentScale);
      pageInfo.textContent = `${appState.pageNum} / ${appState.totalPages}`;
    }
  });

  // PDF auto-update
  window.api.on('pdf:updated', async () => {
    if (appState.currentFilePath) {
      const pdfPath = await window.api.compiler.getPdfPath(appState.currentFilePath);
      if (pdfPath) await loadPdf(pdfPath);
    }
  });

  // External source change (e.g. AI agent edits the file on disk).
  // In collab mode the editor is CRDT-bound: never push disk content into it —
  // ship non-main file changes to the room and recompile instead.
  window.api.on('source:changed', (payload) => {
    if (!appState.currentFilePath) return;
    if (isCollabActive()) {
      handleSourceChanged(payload);
      return;
    }
    const incoming = payload?.content ?? '';
    if (incoming !== editor.state.doc.toString()) {
      setEditorContent(incoming);
    } else {
      scheduleCompile();
    }
  });

  // Package install progress
  window.api.on('compile:progress', (msg) => {
    compileStatus.textContent = msg || '';
    compileStatus.className = 'status-running';
  });

  // Before quit
  window.api.on('app:before-quit', async () => {
    if (appState.modified && appState.currentFilePath) {
      await window.api.file.save(editor.state.doc.toString(), appState.currentFilePath);
    }
    if (isCollabActive()) await flushCollabSave().catch(() => {});
    window.api.app.quit();
  });
}

// ─── Init ───────────────────────────────────────────────────────

async function init() {
  await loadSettings();
  createEditor();
  setupListeners();
  zoomLevel.textContent = '100%';

  setupCollab({
    getAppState: () => appState,
    getEditorContent: () => editor.state.doc.toString(),
    rebuildEditor,
    updatePathUI,
    updateModified,
    runCompile,
    scheduleCompile,
  });

  // DevTools/automation hook — renderer internals are module-scoped, so tests
  // (scripts/gui-collab-test.mjs) and console debugging need a small surface.
  // Must be assigned before the lastFilePath restore below, which returns early.
  window.__livelatex = {
    appState,
    collab,
    openPathDirect: async (filePath) => {
      const result = await window.api.file.openPath(filePath);
      if (!result || isCollabActive()) return result;
      appState.currentFilePath = result.filePath;
      setEditorContent(result.content);
      updatePathUI(result.filePath);
      window.api.watcher.watchSource(result.filePath);
      runCompile();
      return result;
    },
    insertText: (text) => {
      if (!editor) return false;
      // append at the end — inserting at the (default position-0) cursor would
      // put raw text before \documentclass and break the next compile
      editor.dispatch({ changes: { from: editor.state.doc.length, insert: text } });
      return true;
    },
    getDoc: () => editor.state.doc.toString(),
    collabHost: async () => {
      $('collab-name').value = '主机A';
      await startHost();
      return window.api.collab.state();
    },
    collabJoin: async (addr, wsPort) => {
      $('collab-name').value = '队友B';
      await joinRoom({ addr, wsPort });
      return window.api.collab.state();
    },
  };

  const s = await window.api.settings.get();
  if (s?.lastFilePath) {
    const result = await window.api.file.openPath(s.lastFilePath);
    if (result) {
      appState.currentFilePath = result.filePath;
      setEditorContent(result.content);
      updatePathUI(result.filePath);
      window.api.watcher.watchSource(result.filePath);
      runCompile();
      return;
    }
  }
  filePathEl.textContent = '新文档 (Ctrl+N: 新建 Ctrl+O: 打开)';
}

init().catch(console.error);
