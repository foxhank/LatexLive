const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const { initLogger, log, attachRendererLogger } = require('./logger');

initLogger();

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
  attachRendererLogger(mainWindow.webContents);

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
  shutdownCollab();
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
  lastSavedMainContent = content;
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
  lastSavedMainContent = content;
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

const { execFile, exec, execSync } = require('child_process');

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

// ─── Compile scheduler ──────────────────────────────────────────
// Compiles of the same source file must never overlap: they share one temp
// project dir and one build output dir, and an auto-install in the retry loop
// can hold a file "missing" for minutes. During that window every keystroke
// spawns another bare compile that (a) reports ctex.sty not found from BEFORE
// the install finished and (b) races the post-install recompile — the stale
// result can land last and overwrite the good PDF with an error panel.
//
// Rules: one run per source file at a time; while busy, newer requests
// supersede waiting ones; everyone who asked gets the newest executed result.
const runningCompiles = new Map(); // srcPath -> Promise
const queuedCompiles = new Map();  // srcPath -> { makeJob, resolve }

function scheduleCompile(srcPath, makeJob) {
  return new Promise((resolve) => {
    const waiting = queuedCompiles.get(srcPath);
    if (waiting) waiting.resolve = resolve; // superseded job adopts latest waiter
    else queuedCompiles.set(srcPath, { makeJob, resolve });
    pumpCompileQueue(srcPath);
  });
}

function pumpCompileQueue(srcPath) {
  if (runningCompiles.has(srcPath)) return;
  const job = queuedCompiles.get(srcPath);
  if (!job) return;
  queuedCompiles.delete(srcPath);
  const done = Promise.resolve()
    .then(job.makeJob)
    .catch((e) => {
      console.error('[LiveLaTeX] compile scheduler error:', e);
      log('ERROR', `[compile] scheduler exception: ${e.message}`);
      return { success: false, pdfPath: null, errors: [], log: '', elapsed: 0 };
    })
    .then((result) => {
      runningCompiles.delete(srcPath);
      job.resolve(result);
      pumpCompileQueue(srcPath); // run whatever is queued next for this file
    });
  runningCompiles.set(srcPath, done);
}

function findMissingPackages(logContent) {
  const missing = [];
  // Match any "File `xxx' not found" line, e.g. File `cite.sty' not found,
  // File `IEEEtran.cls' not found, File `foo.cty' not found, etc.
  // Keep the full filename (with extension) so tlmgr can search for the exact file.
  const regex = /File `([^']+)' not found/g;
  // Files the user references directly (source/graphics) are not installable packages.
  const userFile = /\.(tex|bib|bbl|blg|png|jpe?g|pdf|eps|svg|ps)$/i;
  let match;
  while ((match = regex.exec(logContent)) !== null) {
    const file = match[1];
    if (userFile.test(file)) continue;
    if (!missing.includes(file)) missing.push(file);
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
  const binDir = path.join(texDir, 'bin', 'windows');
  const tlmgrBat = path.join(binDir, 'tlmgr.bat');
  const tlmgrPl = path.join(texDir, 'texmf-dist', 'scripts', 'texlive', 'tlmgr.pl');
  const perlExe = path.join(texDir, 'tlpkg', 'tlperl', 'bin', 'perl.exe');
  const kpsewhich = path.join(binDir, 'kpsewhich.exe');
  const ctanMirror = 'https://mirrors.tuna.tsinghua.edu.cn/CTAN/systems/texlive/tlnet';

  if (!fs.existsSync(perlExe)) {
    console.warn('[LiveLaTeX] TinyTeX perl not found');
    if (mainWindow) mainWindow.webContents.send('compile:progress', '未找到内置 TinyTeX，无法自动安装宏包');
    callback(); return;
  }

  // Forward proxy env vars only when the user actually has them set — a hardcoded
  // 127.0.0.1 default makes every request hang for users without a local proxy.
  // PERL5LIB + PATH replicate what tlmgr.bat sets before launching perl.
  const makeEnv = () => ({
    ...process.env,
    PATH: `${path.dirname(perlExe)};${binDir};${process.env.PATH}`,
    PERL5LIB: path.join(texDir, 'tlpkg', 'tlperl', 'lib'),
  });

  // Full tlmgr transcript goes to the shared log — the packaged app's console is
  // invisible to end users, and "command failed" alone can't be diagnosed.
  const run = (cmd, args, timeout, env) => new Promise((resolve, reject) => {
    log('INFO', `[tlmgr] $ ${cmd} ${args.join(' ')}`);
    execFile(cmd, args, { timeout, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}`;
      const errOut = `${stderr || ''}`;
      log(err ? 'ERROR' : 'INFO', `[tlmgr] exit=${err ? (err.killed ? `timeout(${timeout}ms)` : err.code) : 0}\n--- output tail ---\n${`${out}\n${errOut}`.slice(-3000)}`);
      if (err) {
        // Node's err.message is just "command failed"; carry the real exit code
        // and both output streams so the failure reason in the UI means something.
        err.exitCode = err.killed ? `timeout` : err.code;
        err.stdoutTail = out.slice(-1000);
        err.stderr = errOut.slice(0, 2000);
        reject(err);
      } else {
        resolve(`${out}\n${errOut}`);
      }
    });
  });

  // Run tlmgr.pl directly instead of through tlmgr.bat: the .bat swallows
  // perl's exit code (verified: a hard failure like "package not present in
  // repository" still exits 0), which forces unreliable output-text matching.
  // Direct invocation gives real exit codes — nonzero means failure, period.
  // The one text check kept below covers the version-gate banner, which may
  // pass as success and would otherwise skip the self-update recovery.
  const tlmgr = async (args, timeout) => {
    const out = await run(perlExe, [tlmgrPl, ...args], timeout, makeEnv());
    if (/itself needs to be updated|please update tlmgr/i.test(out)) {
      const e = new Error('GATE: tlmgr itself needs to be updated');
      e.stderr = out.slice(0, 500);
      throw e;
    }
    return out;
  };
  // `update --self` is the single command that MUST go through tlmgr.bat:
  // the bat's watchdog runs the downloaded updater-w32.bat after tlmgr.pl
  // exits — direct perl invocation makes every self-update a silent no-op.
  const tlmgrSelfUpdate = (repo) => run('cmd.exe', ['/d', '/c', tlmgrBat, '--repository', repo, 'update', '--self'], 600000, makeEnv());
  const progress = (msg) => {
    if (mainWindow) mainWindow.webContents.send('compile:progress', msg);
    console.log(`[LiveLaTeX] ${msg}`);
  };

  // The rolling tlnet repository locks out installs whenever its infrastructure
  // is newer than the bundled TinyTeX ("tlmgr itself needs to be updated") — any
  // prepackaged distribution hits this a few weeks after release. Self-update
  // through the watchdog and retry. A year mismatch cannot be self-updated:
  // fall back to the frozen final repository of the local year instead.
  const tlmgrInstall = async (pkg, repo) => {
    try {
      return await tlmgr(['--repository', repo, 'install', pkg], 600000);
    } catch (e) {
      const msg = `${e.message}\n${e.stderr || ''}`;
      const gate = /tlmgr itself needs to be updated|please update tlmgr/i.test(msg);
      const crossYear = msg.match(/Local TeX Live \((\d{4})\).*older than remote repository/is);
      if (gate) {
        progress('tlmgr 版本过旧，正在自更新 tlmgr ...');
        await tlmgrSelfUpdate(repo); // must go through tlmgr.bat — see above
        return tlmgr(['--repository', repo, 'install', pkg], 600000);
      }
      if (crossYear) {
        const frozen = `https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/${crossYear[1]}/tlnet-final`;
        progress(`TeX Live ${crossYear[1]} 已过期，使用冻结仓库 ...`);
        return tlmgr(['--repository', frozen, 'install', pkg], 600000);
      }
      throw e;
    }
  };

  // Each entry: { file, reason }. Surfaced to the error panel by the caller so a
  // failed install is still visible after the recompile overwrites the status bar.
  const failures = [];
  (async () => {
    for (const file of packages) {
      try {
        // Fast path: most .sty/.cls files ship in a same-named package
        // (ctex.sty → ctex); `tlmgr search --global` has to download the whole
        // remote file database, so only use it when the direct guess fails.
        let realPkg = null;
        const baseName = file.replace(/\.[^.]+$/, '');
        progress(`正在安装 ${baseName} ...`);
        try {
          await tlmgrInstall(baseName, ctanMirror);
          realPkg = baseName;
        } catch (e) {
          if (!/not present|cannot find|unknown package/i.test(`${e.message}\n${e.stderr || ''}`)) throw e;
        }

        if (!realPkg) {
          // Slow path: ask the remote database which package ships this file
          progress(`搜索 ${file} 所属的包...`);
          const searchOut = await tlmgr(['search', '--file', file, '--global'], 120000);
          const m = searchOut.match(/^([a-zA-Z0-9_.-]+):\s*$/m);
          if (!m) throw new Error(`仓库中找不到提供 ${file} 的宏包`);
          realPkg = m[1];
          progress(`正在安装 ${file} → ${realPkg} ...`);
          await tlmgrInstall(realPkg, ctanMirror);
        }

        // Verify the file is actually resolvable now, so a half-failed install
        // surfaces here instead of as "not found" on the next compile
        const where = await run(kpsewhich, [file], 30000, makeEnv());
        if (!where.trim()) throw new Error(`${realPkg} 安装后仍未找到 ${file}`);
        progress(`${file} (${realPkg}) 安装完成 ✓`);
      } catch (err) {
        // Node's default err.message ("command failed") is useless — surface the
        // exit code and the last real output lines instead.
        const tail = `${err.stdoutTail || ''}\n${err.stderr || ''}`.replace(/\s+/g, ' ').trim();
        const exit = err.exitCode !== undefined ? `退出码 ${err.exitCode}` : '';
        const reason = [exit, tail.slice(-240)].filter(Boolean).join(' ') || (err.message || '').slice(0, 200);
        console.error(`[LiveLaTeX] Failed to install ${file}:`, reason);
        progress(`安装 ${file} 失败: ${reason.slice(0, 80)}`);
        failures.push({ file, reason: reason.slice(0, 300) });
      }
    }
    callback(failures);
  })();
}

// Read a LaTeX .log robustly: XeLaTeX emits UTF-8 for most content but falls back
// to the ANSI codepage (CP936 on zh-CN) for paths/messages — decoding those bytes
// as UTF-8 produced mojibake like 'CrDC'. Try strict UTF-8 first, then GBK.
function readTexLog(logPath) {
  try {
    const buf = fs.readFileSync(logPath);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch {
      try { return new TextDecoder('gbk').decode(buf); }
      catch { return buf.toString('latin1'); }
    }
  } catch { return ''; }
}

function runCompile(filePath, resolve) {
  const engine = store.get('engine', 'xelatex');
  // Build INSIDE the project copy: cwd already points at it, so relative
  // assets (fonts/, figures/, cls/sty shipped with the project) resolve
  // naturally, and outputs of different projects never collide.
  const tempDir = path.join(path.dirname(filePath), 'build');
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
  // TeX reports only the FIRST missing file per compile, so a template like
  // CUMCMThesis surfaces its dependencies one at a time. Retry until no NEW
  // missing file appears; every file is attempted at most once, so this
  // terminates. The cap only guards against pathological loops.
  const maxAttempts = 50;
  const triedFiles = new Set();
  // { line: null, message } entries from failed auto-installs; prepended to the
  // final result so the reason stays visible after the recompile replaces the
  // status-bar message with the (still failing) LaTeX error.
  const installErrors = [];

  function doCompile() {
    attempts++;
    const startTime = Date.now();
    execFile(cmd, args, { cwd: path.dirname(filePath), timeout: 120000 }, (err, stdout, stderr) => {
      const logPath = path.join(outDir, `${fileName}.log`);
      const logContent = readTexLog(logPath);

      const pdfPath = path.join(outDir, `${fileName}.pdf`);
      const pdfExists = fs.existsSync(pdfPath);

      const errors = parseLatexErrors(logContent);
      const elapsed = Date.now() - startTime;

      // Auto-install missing packages, then recompile for the next one
      if (!pdfExists && attempts < maxAttempts) {
        const missing = findMissingPackages(logContent).filter((f) => !triedFiles.has(f));
        if (missing.length > 0) {
          missing.forEach((f) => triedFiles.add(f));
          console.log(`[LiveLaTeX] Missing packages: ${missing.join(', ')}, installing...`);
          installMissingPackages(missing, (failures) => {
            // Verified-installed files may still legitimately go missing again
            // (partial fsync, user wiping texmf) — allow a reinstall next round.
            const failedFiles = new Set((failures || []).map((f) => f.file));
            missing.forEach((f) => { if (!failedFiles.has(f)) triedFiles.delete(f); });
            failures.forEach((f) => installErrors.push({ line: null, message: `自动安装 ${f.file} 失败: ${f.reason}` }));
            // Clear aux files to force full recompilation
            doCompile();
          });
          return;
        }
      }

      resolve({ success: !err || pdfExists, pdfPath: pdfExists ? pdfPath : null, errors: pdfExists ? errors : [...installErrors, ...errors], log: logContent, elapsed });
      // Every completion is logged — without this, "panel says not found but
      // install succeeded" races are undiagnosable from the log alone.
      log(pdfExists ? 'INFO' : 'WARN', `[compile] attempt=${attempts} pdf=${pdfExists} err_exit=${err && err.code ? err.code : 0} elapsed=${elapsed}ms` + (pdfExists ? '' : ` first_errors=${errors.slice(0, 3).map((e) => e.message).join(' | ')}`));
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

  // ctex's default Windows fontset requires SimSun/SimHei/KaiTi/FangSong etc.
  // On non-Chinese Windows installs (no CJK language pack) every one of those
  // lookups fails with a fontspec error — the run still "succeeds" under
  // nonstopmode but the PDF is garbled/blank. Tell the user what is actually
  // wrong and how to fix it, instead of N inscrutable errors at preamble lines.
  const missingFont = errors.some((e) =>
    /fontspec Error|The font .* cannot be (found|loaded)|cannot.find font/i.test(e.message));
  if (missingFont && !errors.some((e) => e.message.startsWith('提示：'))) {
    errors.push({
      line: null,
      message: '提示：缺少中文字体（如 SimSun/SimHei/KaiTi）。这台电脑没装中文字体，请在 设置→时间和语言→语言 中安装中文语言包；' +
        '或安装中文语言包不可行时，把模板导言区改为 \\documentclass[fontset=fandol]{ctexart} 并在设置里重试（fandol 是开源替代字体）。',
    });
  }
  return errors;
}

ipcMain.handle('compile:run', (_e, filePath) =>
  scheduleCompile(filePath, () => new Promise((resolve) => runCompile(filePath, resolve))));

// Preview compile: copies project to %TEMP%, compiles temp copy (original untouched).
// Temp-copy creation happens INSIDE the queued job so superseded requests never
// touch the filesystem — only the newest content gets materialized and compiled.
ipcMain.handle('compile:preview', async (_e, filePath, content) => {
  try {
    return await scheduleCompile(filePath, () => {
      const tempTex = makeTempProject(filePath, content);
      return new Promise((resolve) => runCompile(tempTex, resolve));
    });
  } catch (err) {
    console.error('[LiveLaTeX] compile:preview error:', err);
    return { success: false, pdfPath: null, errors: [], log: '', elapsed: 0 };
  }
});

// Preview temp-project mapping — single source of truth for where a given
// source file's preview copy and its build outputs live. Callers pass the
// ORIGINAL user path; the hash scheme must stay identical to makeTempProject.
function previewPathsFor(originalPath) {
  const os = require('os');
  const crypto = require('crypto');
  const base = path.basename(originalPath);
  const hash = crypto.createHash('md5').update(originalPath).digest('hex').slice(0, 8);
  const proj = path.join(os.tmpdir(), 'livelatex-preview', `${base}-${hash}`);
  return { proj, build: path.join(proj, 'build'), base };
}

// Copy the project into a temp dir and write the current editor content into the
// main .tex there, so compiles never touch the user's original files. The whole
// project ships along — fonts/, figures/, bundled cls/sty all end up next to
// the compiled .tex with cwd pointing here, exactly like a local latexmk run.
function makeTempProject(filePath, content) {
  const srcDir = path.dirname(filePath);
  const base = path.basename(filePath);
  const { proj: tempProj } = previewPathsFor(filePath);

  // Re-sync the whole project into the temp dir every compile so it always
  // matches the on-disk project (incl. subfiles/images edited externally).
  fs.rmSync(tempProj, { recursive: true, force: true });
  const skip = ['.git', 'node_modules', 'dist', '.vscode'];
  fs.cpSync(srcDir, tempProj, { recursive: true, filter: (s) => !skip.includes(path.basename(s)) });
  fs.mkdirSync(path.join(tempProj, 'build'), { recursive: true });

  fs.writeFileSync(path.join(tempProj, base), content, 'utf-8');
  return path.join(tempProj, base);
}

// ─── Export: full compile (all passes + bibliography) → save PDF ──

const { promisify } = require('util');
const execFileP = promisify(execFile);

// execFile rejects on nonzero exit; TeX exits nonzero on mere warnings, so
// swallow the error and let callers judge by log/pdf presence instead.
function runEngine(cmd, args, opts) {
  return execFileP(cmd, args, opts).catch((e) => ({ failed: true, error: e }));
}

function resolveLatexmk() {
  const customPath = store.get('enginePath', '');
  if (customPath) return null; // explicit engine path: user knows better, use it directly
  const bundled = path.join(bundledTexDir, 'latexmk.exe');
  if (fs.existsSync(bundled)) return bundled;
  try {
    const which = execSync('where latexmk', { encoding: 'utf-8', stdio: 'pipe' }).trim();
    return which ? which.split('\n')[0].trim() : null;
  } catch { return null; }
}

async function manualFullPasses(texPath, engineCmd, outDir) {
  const srcDir = path.dirname(texPath);
  const fileName = path.basename(texPath, '.tex');
  const baseArgs = ['-interaction=nonstopmode', '-synctex=1', `-output-directory=${outDir}`, texPath];
  const run = () => runEngine(engineCmd, baseArgs, { cwd: srcDir, timeout: 300000 });

  await run();

  // Bibliography: run bibtex between passes when the source uses one
  const src = fs.readFileSync(texPath, 'utf-8');
  if (/\\bibliography\{|\\addbibresource/.test(src)) {
    const engineDir = path.dirname(engineCmd);
    const bibtex = [path.join(engineDir, 'bibtex.exe'), path.join(bundledTexDir, 'bibtex.exe')]
      .find((p) => fs.existsSync(p));
    if (bibtex) {
      await runEngine(bibtex, [fileName], {
        cwd: outDir, timeout: 120000,
        env: { ...process.env, BIBINPUTS: srcDir, BSTINPUTS: srcDir },
      });
    }
  }

  // Two more passes settle the TOC / cross-references
  await run();
  await run();
}

async function exportCompile(texPath) {
  // texPath is the temp project copy — build next to it so relative assets resolve
  const outDir = path.join(path.dirname(texPath), 'build');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const fileName = path.basename(texPath, '.tex');
  const logPath = path.join(outDir, `${fileName}.log`);
  const pdfPath = path.join(outDir, `${fileName}.pdf`);
  const readLog = () => readTexLog(logPath);

  const engine = store.get('engine', 'xelatex');
  const latexmk = resolveLatexmk();
  // latexmk reruns the engine and runs bibtex/biber as needed in one call
  const latexmkFlag = { xelatex: '-xelatex', pdflatex: '-pdf', lualatex: '-lualatex', latexmk: '-xelatex' }[engine] || '-xelatex';

  const tried = new Set();
  const installErrors = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    const startTime = Date.now();
    if (latexmk) {
      await runEngine(latexmk, [latexmkFlag, '-interaction=nonstopmode', '-synctex=1', `-output-directory=${outDir}`, texPath],
        { cwd: path.dirname(texPath), timeout: 600000 });
    } else {
      await manualFullPasses(texPath, getEngineCmd(), outDir);
    }
    const log = readLog();
    const elapsed = Date.now() - startTime;

    if (fs.existsSync(pdfPath)) return { success: true, pdfPath, errors: parseLatexErrors(log), log, elapsed };

    // Same missing-package auto-install loop as the preview compile
    const missing = findMissingPackages(log).filter((f) => !tried.has(f));
    if (!missing.length) return { success: false, pdfPath: null, errors: [...installErrors, ...parseLatexErrors(log)], log, elapsed };
    missing.forEach((f) => tried.add(f));
    console.log(`[LiveLaTeX] Export: missing packages ${missing.join(', ')}, installing...`);
    const failures = await new Promise((res) => installMissingPackages(missing, res));
    failures.forEach((f) => installErrors.push({ line: null, message: `自动安装 ${f.file} 失败: ${f.reason}` }));
  }
  const log = readLog();
  return { success: false, pdfPath: null, errors: [...installErrors, ...parseLatexErrors(log)], log, elapsed: 0 };
}

ipcMain.handle('compile:export', async (_e, filePath, content) => {
  try {
    const tempTex = makeTempProject(filePath, content);
    const result = await exportCompile(tempTex);
    if (!result.success) return { ...result, savedPath: null };

    const defaultName = path.join(path.dirname(filePath), `${path.basename(filePath, '.tex')}.pdf`);
    const dlg = await dialog.showSaveDialog(mainWindow || undefined, {
      title: '导出 PDF',
      defaultPath: defaultName,
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
    });
    if (dlg.canceled || !dlg.filePath) return { ...result, savedPath: null, canceled: true };

    fs.copyFileSync(result.pdfPath, dlg.filePath);
    shell.showItemInFolder(dlg.filePath);
    console.log('[LiveLaTeX] Exported PDF:', dlg.filePath);
    return { ...result, savedPath: dlg.filePath };
  } catch (err) {
    console.error('[LiveLaTeX] compile:export error:', err);
    return { success: false, pdfPath: null, savedPath: null, errors: [{ message: String(err?.message || err), line: null }], log: '', elapsed: 0 };
  }
});

ipcMain.handle('compile:get-pdf-path', (_e, filePath) => {
  const { build, base } = previewPathsFor(filePath);
  const pdfPath = path.join(build, `${base.slice(0, -4)}.pdf`);
  return fs.existsSync(pdfPath) ? pdfPath : null;
});

ipcMain.handle('compile:get-log', (_e, filePath) => {
  const { build, base } = previewPathsFor(filePath);
  const logPath = path.join(build, `${base.slice(0, -4)}.log`);
  return readTexLog(logPath);
});

// ─── SyncTeX ────────────────────────────────────────────────────

ipcMain.handle('synctex:forward', async (_e, line, col, texPath) => {
  const { build, proj, base } = previewPathsFor(texPath);
  const fileName = base.slice(0, -4);
  const pdfPath = path.join(build, `${fileName}.pdf`);
  const synctexGz = path.join(build, `${fileName}.synctex.gz`);

  if (!fs.existsSync(synctexGz)) return null;

  // The .tex that synctex recorded is the TEMP project copy, not the original —
  // query with that path so the binary and fallback parser both match.
  const compiledTex = path.join(proj, base);
  try {
    const result = execSync(
      `synctex view -i ${line}:${col + 1}:${compiledTex.replace(/\//g, '\\')} -o ${pdfPath.replace(/\//g, '\\')}`,
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
    const tag = `{${compiledTex.replace(/\\/g, '/')}}`;
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
  const { build } = previewPathsFor(texPath);
  const fileName = path.basename(texPath, '.tex');
  const pdfPath = path.join(build, `${fileName}.pdf`);
  const synctexGz = path.join(build, `${fileName}.synctex.gz`);

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

// Source watcher: re-render when an external tool (e.g. AI agent) edits the original file
let sourceWatcher = null;
let sourceDebounce = null;
let lastSavedMainContent = null;
const pendingSourceChanges = new Set();

ipcMain.handle('watcher:watch-source', (_e, filePath) => {
  if (sourceWatcher) sourceWatcher.close();
  lastSavedMainContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
  const mainFile = filePath;
  const dir = path.dirname(filePath);

  sourceWatcher = chokidar.watch(dir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    ignored: /\.(pdf|log|aux|out|toc|bbl|blg|fls|fdb_latexmk|synctex\.gz)$/i,
  });

  const notify = () => {
    clearTimeout(sourceDebounce);
    sourceDebounce = setTimeout(() => {
      const changes = [...pendingSourceChanges];
      pendingSourceChanges.clear();
      let cur = null;
      try { cur = fs.readFileSync(mainFile, 'utf-8'); } catch {}
      const mainChanged = changes.some((c) => path.resolve(c) === path.resolve(mainFile));
      // Ignore our own Ctrl+S write (echo), so we don't loop save→reload→compile.
      if (mainChanged && cur === lastSavedMainContent) return;
      lastSavedMainContent = cur;
      mainWindow?.webContents.send('source:changed', { content: cur, changedPaths: changes });
    }, 250);
  };

  const onFileChange = (p) => { pendingSourceChanges.add(p); notify(); };
  sourceWatcher.on('add', onFileChange).on('change', onFileChange);
});

ipcMain.handle('watcher:unwatch-source', () => {
  if (sourceWatcher) sourceWatcher.close();
  sourceWatcher = null;
  lastSavedMainContent = null;
  pendingSourceChanges.clear();
});

// ─── System ─────────────────────────────────────────────────────

ipcMain.handle('app:quit', () => {
  isQuitting = true;
  app.quit();
});

ipcMain.handle('app:get-path', (_e, name) => app.getPath(name));

// ─── LAN collaboration ──────────────────────────────────────────

const { initCollab } = require('./collab');
initCollab({
  getWin: () => mainWindow,
  // The CRDT autosave writes the same file Ctrl+S does — feed the watcher's
  // echo suppression so remote edits don't bounce back as "external changes".
  setLastSaved: (content) => { lastSavedMainContent = content; },
  store,
});
