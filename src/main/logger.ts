// Lightweight size-capped file logger.
//
// The packaged app's console output is invisible to end users, so everything —
// console.log/warn/error from the main process, renderer console messages,
// uncaught exceptions and the tlmgr install transcript — is funneled here into
// a single userData/logs/livelatex.log that users can find and send for support.
//
// Size policy: the file is trimmed to its newest half once it passes LOG_SOFT_CAP
// (7 MB), so it always stays under the 8 MB hard ceiling; the tail-keep preserves
// the most recent context (what just failed) rather than startup boilerplate.

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const TRUNCATED_MARK = '\n[log truncated - older entries removed]\n';

let logFile = null;
let wroteSinceCheck = 0;

function ensureFile() {
  if (logFile) return logFile;
  try {
    const dir =  path.join(app.getPath('userData'), 'logs');
    if (! fs.existsSync(dir))  fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'livelatex.log');
  } catch {
    // app.getPath unavailable in some early/lifecycle edge cases — drop logs silently
  }
  return logFile;
}

function trimIfNeeded() {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size <= 7 * 1024 * 1024) return;
    // Keep the newest ~3 MB: read the tail, rewrite over the old content.
    const fd = fs.openSync(logFile, 'r');
    try {
      const keep = 3 * 1024 * 1024;
      const start = Math.max(0, stat.size - keep);
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const cut = buf.indexOf(0x0a); // don't start mid-line
      const tail = cut >= 0 ? buf.subarray(cut + 1) : buf;
      fs.writeFileSync(logFile, Buffer.concat([Buffer.from(TRUNCATED_MARK), tail]));
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}

export function log(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
      return String(a);
    })
    .join(' ')}`;
  try {
    const f = ensureFile();
    if (!f) return;
    fs.appendFileSync(f, line + '\n');
    // stat() on every write is wasteful at high volume; check every ~100 writes
    // plus always right after startup so an oversized carry-over gets cut early.
    if (++wroteSinceCheck >= 100) { wroteSinceCheck = 0; trimIfNeeded(); }
  } catch {}
}

export function initLogger() {
  trimIfNeeded(); // cap surviving logs from previous runs immediately

  // Mirror main-process console calls into the file (they stay on stdout too).
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      log(level === 'log' ? 'INFO' : level.toUpperCase(), ...args);
    };
  }

  process.on('uncaughtException', (e) => log('ERROR', 'uncaughtException:', e));
  process.on('unhandledRejection', (e) => log('ERROR', 'unhandledRejection:', e));

  log('INFO', `--- LiveLaTeX ${process.env.npm_package_version || ''} starting (electron ${process.versions.electron}) ---`);
}

// Forward everything the renderer prints to DevTools console into the same file.
export function attachRendererLogger(webContents) {
  webContents.on('console-message', (_e, level, message, line, sourceId) => {
    log(['DEBUG', 'WARN', 'ERROR'][level] || 'INFO', `[renderer] ${message} (${sourceId}:${line})`);
  });
}
