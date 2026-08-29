// GUI double-instance collab test: launches two real Electron windows and
// drives them over the Chrome DevTools Protocol.
//
//   A (port 9222) opens a project and hosts a room
//   B (port 9223) joins, receives the project mirror, and compiles locally
//
// Verifies the full user-facing path: CRDT text both directions, peer list,
// image asset propagation (watcher → publish → mirror), local compile on the
// guest, and host-close teardown.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── minimal CDP client ────────────────────────────────────────
async function cdpConnect(port) {
  let list;
  const t0 = Date.now();
  while (true) {
    try {
      list = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
      });
      break;
    } catch (e) {
      if (Date.now() - t0 > 30000) throw new Error(`CDP ${port} unreachable: ${e.message}`);
      await sleep(500);
    }
  }
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res) => ws.on('open', res));
  let seq = 0;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  return {
    evaluate: async (expression) => {
      const id = ++seq;
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      const res = await new Promise((res) => pending.set(id, res));
      if (res.result?.exceptionDetails) throw new Error('CDP eval: ' + JSON.stringify(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails).slice(0, 300));
      return res.result?.result?.value;
    },
    close: () => ws.close(),
  };
}

async function waitReady(cdp) {
  for (let i = 0; i < 60; i++) {
    try {
      if (await cdp.evaluate('!!window.__livelatex')) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('renderer not ready (no __livelatex hook)');
}

async function waitFor(name, fn, timeoutMs = 20000, everyMs = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for ${name}`);
}

function launchElectron(debugPort) {
  const p = spawn(require('electron'), ['.', '--remote-debugging-port=' + debugPort], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write(`[electron:${debugPort}] ${d}`));
  p.on('exit', (code) => { if (code) console.log(`[electron:${debugPort}] exited early: ${code}`); });
  return p;
}

async function main() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'livelatex-gui-'));
  fs.writeFileSync(path.join(proj, 'main.tex'),
    '\\documentclass{article}\n\\begin{document}\nGUI协作测试\n\\end{document}\n');
  let electronA, electronB;
  let cdpA, cdpB;

  try {
    // ── instance A: open project, host ────────────────────────
    electronA = launchElectron(9222);
    cdpA = await cdpConnect(9222);
    await waitReady(cdpA);
    await cdpA.evaluate(`__livelatex.openPathDirect(${JSON.stringify(path.join(proj, 'main.tex'))})`);
    await waitFor('A opens file', () => cdpA.evaluate('__livelatex.appState.currentFilePath'));
    const hostState = await cdpA.evaluate('__livelatex.collabHost()');
    check('A hosts room', hostState && hostState.active && hostState.role === 'host', JSON.stringify(hostState));

    // ── instance B: join ─────────────────────────────────────
    electronB = launchElectron(9223);
    cdpB = await cdpConnect(9223);
    await waitReady(cdpB);
    const joinState = await cdpB.evaluate(`__livelatex.collabJoin('127.0.0.1', ${hostState.wsPort})`);
    check('B joins room', joinState && joinState.active && joinState.role === 'guest', JSON.stringify(joinState));

    check('B sees A content', (await cdpB.evaluate('__livelatex.getDoc()')).includes('GUI协作测试'));

    // ── peers ─────────────────────────────────────────────────
    await waitFor('peers list on A', () => cdpA.evaluate('__livelatex.collab.peers.length >= 2'));
    await waitFor('peers list on B', () => cdpB.evaluate('__livelatex.collab.peers.length >= 2'), 10000);
    check('B peer list has 2', (await cdpB.evaluate('__livelatex.collab.peers.length')) === 2);

    // ── text A → B (autosave → disk → watcher → publish → apply) ──
    await cdpA.evaluate(`__livelatex.insertText('ABC主机')`);
    await waitFor('B receives A edit', () => cdpB.evaluate('__livelatex.getDoc().includes("ABC主机")'), 30000);
    // ── text B → A ───────────────────────────────────────────
    await cdpB.evaluate(`__livelatex.insertText('XYZ队友')`);
    await waitFor('A receives B edit', () => cdpA.evaluate('__livelatex.getDoc().includes("XYZ队友")'), 30000);

    // ── asset: drop an image into A's project, B's mirror gets it ──
    fs.mkdirSync(path.join(proj, 'figs'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'figs', 'pic.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const bMirror = await cdpB.evaluate('__livelatex.collab.localPath');
    check('B mirror path set', !!bMirror, bMirror || '');
    const bDir = await cdpB.evaluate('__livelatex.collab.projectDir');
    check('B shared-folder path set', !!bDir && fs.existsSync(bDir), bDir || '');
    await waitFor('asset reaches B mirror', () =>
      Promise.resolve(fs.existsSync(path.join(path.dirname(bMirror), 'figs', 'pic.png'))), 15000);

    // ── guest compiles locally with bundled TinyTeX ──────────
    await waitFor('B compile status settles', () => cdpB.evaluate(
      `(() => { const t = document.getElementById('compile-status').textContent; return /编译|同步/.test(t) && !/编译中|等待/.test(t) ? t : false })()`
    ), 180000, 1000).then(async (s) => {
      const ok = String(s).includes('成功');
      check('B compiled locally', ok, String(s));
      if (!ok) {
        const errs = await cdpB.evaluate(`document.getElementById('error-list').innerText.slice(0, 400)`);
        console.log('   B error panel:', JSON.stringify(errs));
        const bDoc = await cdpB.evaluate('__livelatex.getDoc()');
        console.log('   B doc head:', JSON.stringify(bDoc.slice(0, 120)));
      }
    }, () => {
      check('B compiled locally', false, 'timeout');
    });

    // ── teardown: host closes, guest leaves cleanly ──────────
    await cdpA.evaluate('__livelatex.collab.active && window.api.collab.leave()');
    await waitFor('B notices closure', () => cdpB.evaluate('!__livelatex.collab.active'));
    check('B exited cleanly', true);
  } catch (e) {
    failures++;
    console.log('❌ FATAL', e.message);
  } finally {
    try { cdpA && cdpA.close(); } catch {}
    try { cdpB && cdpB.close(); } catch {}
    await sleep(300);
    try { electronA && electronA.kill(); } catch {}
    try { electronB && electronB.kill(); } catch {}
    await sleep(500);
    try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
  }

  console.log(failures === 0 ? '\n🎉 GUI TEST ALL PASS' : `\n💥 ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
