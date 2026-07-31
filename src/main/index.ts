const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const store = new Store({
  defaults: {
    engine: 'xelatex',
    enginePath: '',
    editorFont: 'Consolas',
    editorFontSize: 14,
    theme: 'light',
    debounceMs: 800,
    lastFilePath: '',
    recentFiles: [],
  },
});

let mainWindow = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 500,
    title: 'LiveLaTeX',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Open DevTools in dev mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.webContents.send('app:before-quit');
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC Handlers ────────────────────────────────────────────────

// Settings
ipcMain.handle('settings:get', () => store.store);
ipcMain.handle('settings:set', (_e, key, value) => {
  store.set(key, value);
  return store.store;
});

// File operations
ipcMain.handle('file:open', async () => {
  try {
    if (mainWindow) { mainWindow.focus(); mainWindow.show(); }
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      properties: ['openFile'],
      filters: [{ name: 'LaTeX', extensions: ['tex'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;

    const filePath = result.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf-8');
    store.set('lastFilePath', filePath);
    addRecentFile(filePath);
    console.log('[LiveLaTeX] Opened file:', filePath);
    return { content, filePath };
  } catch (err) {
    console.error('[LiveLaTeX] file:open error:', err);
    return null;
  }
});

ipcMain.handle('file:open-path', async (_e, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    store.set('lastFilePath', filePath);
    addRecentFile(filePath);
    return { content, filePath };
  } catch (err) {
    console.error('[LiveLaTeX] file:open-path error:', err);
    return null;
  }
});

ipcMain.handle('file:save', async (_e, content, filePath) => {
  if (!filePath) {
    const result = await dialog.showSaveDialog(mainWindow || undefined, {
      defaultPath: 'untitled.tex',
      filters: [{ name: 'LaTeX', extensions: ['tex'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    filePath = result.filePath;
  }
  fs.writeFileSync(filePath, content, 'utf-8');
  addRecentFile(filePath);
  store.set('lastFilePath', filePath);
  console.log('[LiveLaTeX] Saved file:', filePath);
  return { filePath, saved: true };
});

ipcMain.handle('file:save-as', async (_e, content) => {
  const result = await dialog.showSaveDialog(mainWindow || undefined, {
    defaultPath: 'untitled.tex',
    filters: [{ name: 'LaTeX', extensions: ['tex'] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, content, 'utf-8');
  addRecentFile(result.filePath);
  store.set('lastFilePath', result.filePath);
  return { filePath: result.filePath, saved: true };
});

ipcMain.handle('file:select-executable', async () => {
  if (mainWindow) { mainWindow.focus(); mainWindow.show(); }
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    properties: ['openFile'],
    filters: [{ name: 'Executable', extensions: ['exe', 'bat', 'cmd'] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('file:read', async (_e, filePath) => {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
});

ipcMain.handle('file:read-binary', async (_e, filePath) => {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath).buffer;
});

ipcMain.handle('file:read-pdf', async (_e, filePath) => {
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  return { data: buf.toString('base64'), size: buf.length };
});

function addRecentFile(filePath) {
  let recent = store.get('recentFiles', []);
  recent = recent.filter((f) => f !== filePath);
  recent.unshift(filePath);
  if (recent.length > 20) recent = recent.slice(0, 20);
  store.set('recentFiles', recent);
}

// ─── Compiler ────────────────────────────────────────────────────

const { execFile, exec } = require('child_process');

let compileTimer = null;
let isCompiling = false;
const compileQueue = [];

// Bundled TinyTeX path (dev & packaged)
const bundledTexDir = (() => {
  const pkg = path.join(process.resourcesPath || '', 'texlive', 'TinyTeX', 'bin', 'windows');
  if (require('fs').existsSync(pkg)) return pkg;
  const dev = path.join(__dirname, '..', '..', 'texlive', 'TinyTeX', 'bin', 'windows');
  if (require('fs').existsSync(dev)) return dev;
  return dev; // fallback
})();

function getEngineCmd() {
  const customPath = store.get('enginePath', '');
  const engine = store.get('engine', 'xelatex');
  if (customPath) return customPath;

  // Check bundled TinyTeX first
  const bundledPath = path.join(bundledTexDir, `${engine}.exe`);
  if (fs.existsSync(bundledPath)) return bundledPath;

  // Try to find in PATH
  const candidates = [engine, 'latexmk', 'pdflatex', 'lualatex', 'xelatex'];
  for (const cmd of candidates) {
    try {
      const which = require('child_process').execSync(`where ${cmd}`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (which) return which.split('\n')[0].trim();
    } catch {}
  }
  return engine; // fallback
}

function detectEngines() {
  const found = [];
  const candidates = ['xelatex', 'pdflatex', 'lualatex', 'latexmk'];

  // Check bundled TinyTeX
  for (const cmd of candidates) {
    const bundledPath = path.join(bundledTexDir, `${cmd}.exe`);
    if (fs.existsSync(bundledPath)) found.push(`bundled:${cmd}`);
  }

  // Check system PATH
  for (const cmd of candidates) {
    try {
      require('child_process').execSync(`where ${cmd}`, { stdio: 'pipe', encoding: 'utf-8' });
      found.push(cmd);
    } catch {}
  }
  return found;
}
ipcMain.handle('compiler:detect', () => detectEngines());

function findMissingPackages(logContent) {
  const missing = [];
  // Match: File `cite.sty' not found.  or  File `IEEEtran.cls' not found.
  const regex = /File `([^']+\.(sty|cls|bst|clo|def))' not found/g;
  let match;
  while ((match = regex.exec(logContent)) !== null) {
    const pkg = match[1].replace(/\.(sty|cls|bst|clo|def)$/, '');
    if (!missing.includes(pkg)) missing.push(pkg);
  }
  return missing;
}

function installMissingPackages(packages, callback) {
  // dev / packaged path resolution
  const texDir = (() => {
    const pkg = path.join(process.resourcesPath || '', 'texlive', 'TinyTeX');
    if (require('fs').existsSync(pkg)) return pkg;
    const dev = path.join(__dirname, '..', '..', 'texlive', 'TinyTeX');
    if (require('fs').existsSync(dev)) return dev;
    return pkg;
  })();
  const perlPath = path.join(texDir, 'tlpkg', 'tlperl', 'bin', 'perl.exe');
  const tlmgrScript = path.join(texDir, 'texmf-dist', 'scripts', 'texlive', 'tlmgr.pl');
  const binDir = path.join(texDir, 'bin', 'windows');
  const ctanMirror = 'https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet';

  if (!fs.existsSync(perlPath) || !fs.existsSync(tlmgrScript)) {
    console.warn('[LiveLaTeX] TinyTeX perl/tlmgr not found');
    callback(); return;
  }

  const tlmgr = (args) => new Promise((resolve, reject) => {
    execFile(perlPath, args, {
      timeout: 180000,
      env: { ...process.env, PATH: `${binDir};${process.env.PATH}`,
        HTTP_PROXY: process.env.HTTP_PROXY || 'http://127.0.0.1:7890',
        HTTPS_PROXY: process.env.HTTPS_PROXY || 'http://127.0.0.1:7890' }
    }, (err, stdout, stderr) => err ? reject(err) : resolve(stdout));
  });

  (async () => {
    for (const pkg of packages) {
      const styFile = `${pkg}.sty`;
      if (mainWindow) mainWindow.webContents.send('compile:progress', `搜索 ${styFile} 所属的包...`);
      console.log(`[LiveLaTeX] Searching for package containing ${styFile}`);

      try {
        // Step 1: search for which package provides this .sty file
        const searchOut = await tlmgr([tlmgrScript, 'search', '--file', styFile, '--global']);

        // Parse tlmgr search output format:
        // algorithms:
        //     texmf-dist/tex/latex/algorithms/algorithmic.sty
        let realPkg = pkg;
        const lines = searchOut.split('\n');
        for (const line of lines) {
          const m = line.match(/^([a-zA-Z0-9_.-]+):\s*$/);
          if (m) { realPkg = m[1]; break; }
        }

        if (mainWindow) mainWindow.webContents.send('compile:progress', `正在安装 ${styFile} → ${realPkg} ...`);
        console.log(`[LiveLaTeX] Installing ${realPkg} for ${styFile}`);
        await tlmgr([tlmgrScript, '--repository', ctanMirror, 'install', realPkg]);

        if (mainWindow) mainWindow.webContents.send('compile:progress', `${styFile} (${realPkg}) 安装完成 ✓`);
        console.log(`[LiveLaTeX] Successfully installed ${realPkg}`);
      } catch (err) {
        console.error(`[LiveLaTeX] Failed to install ${pkg}:`, err.message);
        if (mainWindow) mainWindow.webContents.send('compile:progress', `安装 ${pkg} 失败: ${err.message.slice(0, 60)}`);
      }
    }
    callback();
  })();
}

function runCompile(filePath, resolve) {
  const engine = store.get('engine', 'xelatex');
  const tempDir = path.join(app.getPath('userData'), 'build');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const fileName = path.basename(filePath, '.tex');
  const outDir = tempDir;

  // Use getEngineCmd() which checks bundled TinyTeX, then PATH, then falls back
  const cmd = getEngineCmd();
  const args = [];

  if (engine === 'latexmk') {
    args.push('-xelatex', '-interaction=nonstopmode', '-synctex=1', `-output-directory=${outDir}`, filePath);
  } else {
    args.push('-interaction=nonstopmode', '-synctex=1', `-output-directory=${outDir}`, filePath);
  }

  let attempts = 0;
  const maxAttempts = 2;

  function doCompile() {
    attempts++;
    const startTime = Date.now();
    execFile(cmd, args, { cwd: path.dirname(filePath), timeout: 120000 }, (err, stdout, stderr) => {
      const logPath = path.join(outDir, `${fileName}.log`);
      let logContent = '';
      try { logContent = fs.readFileSync(logPath, 'utf-8'); } catch {}

      const pdfPath = path.join(outDir, `${fileName}.pdf`);
      const pdfExists = fs.existsSync(pdfPath);

      const errors = parseLatexErrors(logContent);
      const elapsed = Date.now() - startTime;

      // Auto-install missing packages on first failure, then retry once
      if (!pdfExists && attempts < maxAttempts) {
        const missing = findMissingPackages(logContent);
        if (missing.length > 0) {
          console.log(`[LiveLaTeX] Missing packages: ${missing.join(', ')}, installing...`);
          installMissingPackages(missing, () => {
            // Clear aux files to force full recompilation
            doCompile();
          });
          return;
        }
      }

      resolve({ success: !err || pdfExists, pdfPath: pdfExists ? pdfPath : null, errors, log: logContent, elapsed });
    });
  }

  doCompile();
}

function parseLatexErrors(log) {
  const errors = [];
  // Match: ! <error text>
  // Then: l.<line> ...
  const lines = log.split('\n');
  let currentError = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('! ')) {
      if (currentError) errors.push(currentError);
      currentError = { message: line.slice(2).trim(), line: null };
    } else if (currentError && line.includes('l.')) {
      const m = line.match(/l\.(\d+)/);
      if (m) currentError.line = parseInt(m[1], 10);
    }
  }
  if (currentError) errors.push(currentError);
  return errors;
}

ipcMain.handle('compile:run', async (_e, filePath) => {
  return new Promise((resolve) => runCompile(filePath, resolve));
});

// Preview compile: copies project to %TEMP%, compiles temp copy (original untouched)
const previewDirs = new Map(); // filePath -> tempProjectDir

ipcMain.handle('compile:preview', async (_e, filePath, content) => {
  try {
    const os = require('os');
    const crypto = require('crypto');
    const srcDir = path.dirname(filePath);
    const base = path.basename(filePath);

    let tempProj = previewDirs.get(filePath);
    if (!tempProj || !fs.existsSync(tempProj)) {
      const hash = crypto.createHash('md5').update(filePath).digest('hex').slice(0, 8);
      tempProj = path.join(os.tmpdir(), 'livelatex-preview', `${base}-${hash}`);
      if (fs.existsSync(tempProj)) fs.rmSync(tempProj, { recursive: true, force: true });
      fs.cpSync(srcDir, tempProj, { recursive: true });
      previewDirs.set(filePath, tempProj);
    }

    // Write current editor content into temp copy of main .tex
    fs.writeFileSync(path.join(tempProj, base), content, 'utf-8');

    return new Promise((resolve) => runCompile(path.join(tempProj, base), resolve));
  } catch (err) {
    console.error('[LiveLaTeX] compile:preview error:', err);
    return { success: false, pdfPath: null, errors: [], log: '', elapsed: 0 };
  }
});

ipcMain.handle('compile:get-pdf-path', (_e, filePath) => {
  const tempDir = path.join(app.getPath('userData'), 'build');
  const fileName = path.basename(filePath, '.tex');
  const pdfPath = path.join(tempDir, `${fileName}.pdf`);
  return fs.existsSync(pdfPath) ? pdfPath : null;
});

ipcMain.handle('compile:get-log', (_e, filePath) => {
  const tempDir = path.join(app.getPath('userData'), 'build');
  const fileName = path.basename(filePath, '.tex');
  const logPath = path.join(tempDir, `${fileName}.log`);
  try { return fs.readFileSync(logPath, 'utf-8'); } catch { return ''; }
});

// ─── SyncTeX ────────────────────────────────────────────────────

ipcMain.handle('synctex:forward', async (_e, line, col, texPath) => {
  const tempDir = path.join(app.getPath('userData'), 'build');
  const fileName = path.basename(texPath, '.tex');
  const pdfPath = path.join(tempDir, `${fileName}.pdf`);
  const synctexGz = path.join(tempDir, `${fileName}.synctex.gz`);

  if (!fs.existsSync(synctexGz)) return null;

  // Try synctex binary first
  try {
    const result = execSync(
      `synctex view -i ${line}:${col + 1}:${texPath.replace(/\//g, '\\')} -o ${pdfPath.replace(/\//g, '\\')}`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const m = result.match(/Page:\s*(\d+)/);
    const xm = result.match(/x:\s*([\d.]+)/);
    const ym = result.match(/y:\s*([\d.]+)/);
    const wm = result.match(/h:\s*([\d.]+)/);
    if (m) return { page: parseInt(m[1], 10), x: xm ? parseFloat(xm[1]) : 0, y: ym ? parseFloat(ym[1]) : 0, h: wm ? parseFloat(wm[1]) : 0 };
  } catch {}

  // Fallback: parse .synctex.gz manually (simple heuristic)
  try {
    const zlib = require('zlib');
    const buf = zlib.gunzipSync(fs.readFileSync(synctexGz));
    const text = buf.toString('utf-8');
    const tag = `{${texPath.replace(/\\/g, '/')}}`;
    const idx = text.indexOf(tag);
    if (idx === -1) return null;

    // Scan backward to find the nearest Page: block
    const before = text.slice(0, idx);
    const pageMatch = before.match(/Page:(\d+)[^]*?(?=Page:|$)/g);
    if (pageMatch && pageMatch.length > 0) {
      const lastPage = pageMatch[pageMatch.length - 1];
      const pm = lastPage.match(/Page:(\d+)/);
      if (pm) return { page: parseInt(pm[1], 10), x: 0, y: 0, h: 0 };
    }
  } catch {}

  return null;
});

ipcMain.handle('synctex:backward', async (_e, page, x, y, texPath) => {
  const tempDir = path.join(app.getPath('userData'), 'build');
  const fileName = path.basename(texPath, '.tex');
  const pdfPath = path.join(tempDir, `${fileName}.pdf`);
  const synctexGz = path.join(tempDir, `${fileName}.synctex.gz`);

  if (!fs.existsSync(synctexGz)) return null;

  try {
    const result = execSync(
      `synctex edit -p ${page} -x ${x} -y ${y} ${pdfPath.replace(/\//g, '\\')}`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const m = result.match(/Line:\s*(\d+)/);
    if (m) return { line: parseInt(m[1], 10) };
  } catch {}

  // Fallback: parse .synctex.gz
  try {
    const zlib = require('zlib');
    const buf = zlib.gunzipSync(fs.readFileSync(synctexGz));
    const text = buf.toString('utf-8');
    const pageMarker = `Page:${page}`;
    const pageIdx = text.indexOf(pageMarker);
    if (pageIdx === -1) return null;

    const afterPage = text.slice(pageIdx);
    const inputMatch = afterPage.match(/\{([^}]+\.tex)\}/);
    if (inputMatch) {
      // Try to find line number near the input block
      const inputStart = afterPage.indexOf(inputMatch[0]);
      const blockBefore = afterPage.slice(0, inputStart);
      const lineMatch = blockBefore.match(/x:([\d.]+)[\s\S]*?y:([\d.]+)/);
      return { line: 1 }; // fallback to first line
    }
  } catch {}

  return { line: 1 };
});

// ─── File watching ──────────────────────────────────────────────

const chokidar = require('chokidar');
let pdfWatcher = null;

ipcMain.handle('watcher:watch-pdf', (_e, pdfPath) => {
  if (pdfWatcher) pdfWatcher.close();
  if (!pdfPath || !fs.existsSync(pdfPath)) return;

  pdfWatcher = chokidar.watch(pdfPath, { awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } });
  pdfWatcher.on('change', () => {
    mainWindow?.webContents.send('pdf:updated');
  });
});

ipcMain.handle('watcher:unwatch', () => {
  if (pdfWatcher) pdfWatcher.close();
  pdfWatcher = null;
});

// ─── System ─────────────────────────────────────────────────────

ipcMain.handle('app:quit', () => {
  isQuitting = true;
  app.quit();
});

ipcMain.handle('app:get-path', (_e, name) => app.getPath(name));
