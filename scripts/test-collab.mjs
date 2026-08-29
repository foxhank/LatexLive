// LAN collaboration protocol test — headless, two processes.
//
//   this process  = HOST: real collab module (electron stubbed) + a y-websocket
//                   client playing the host renderer's editor (client A)
//   child process = GUEST: real collab module (join/mirror/assets) + its own
//                   y-websocket client playing the guest renderer (client B)
//
// Verifies: UDP discovery, join+snapshot mirror, guest→host asset,
// host→guest asset, CRDT convergence under concurrent edits, awareness,
// and clean teardown. Exits 0 only if every assertion holds.
import { build } from 'esbuild';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Bundle the real collab module with electron aliased to the stub
  await build({
    entryPoints: [path.join(root, 'src/main/collab.ts')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node22',
    outfile: path.join(root, 'test-dist/collab.cjs'),
    alias: { electron: path.join(root, 'scripts/electron-stub.cjs') },
    external: ['ws', 'bufferutil', 'utf-8-validate'],
  });

  // ── HOST setup ─────────────────────────────────────────────
  const collab = require(path.join(root, 'test-dist/collab.cjs'));
  const handlers = require('./electron-stub.cjs').__collabHandlers;
  const lastSaved = { content: null };
  collab.initCollab({ getWin: () => null, setLastSaved: (c) => { lastSaved.content = c; }, store: {} });

  const hostProj = fs.mkdtempSync(path.join(os.tmpdir(), 'livelatex-host-'));
  const mainTex = path.join(hostProj, 'main.tex');
  fs.mkdirSync(path.join(hostProj, 'sections'));
  fs.writeFileSync(mainTex, '\\documentclass{article}\n\\begin{document}\n你好，协作测试\n\\end{document}\n');
  fs.writeFileSync(path.join(hostProj, 'sections', 'intro.tex'), 'intro subfile\n');

  const hostRes = await handlers.get('collab:start-host')(null, mainTex, fs.readFileSync(mainTex, 'utf-8'), '主持人A');
  check('start-host ok', hostRes.ok, JSON.stringify(hostRes).slice(0, 120));
  if (!hostRes.ok) process.exit(1);

  // Client A — simulates the host renderer (y-websocket + awareness)
  const { WebsocketProvider } = require('y-websocket');
  const Y = require('yjs');
  const ydocA = new Y.Doc();
  const provA = new WebsocketProvider(`ws://127.0.0.1:${hostRes.wsPort}`, hostRes.roomId, ydocA);
  await new Promise((res) => { if (provA.synced) res(); else provA.on('sync', (s) => s && res()); });
  check('client A synced', provA.synced);
  const textA = ydocA.getText('content');
  check('client A sees seeded content', textA.toString().includes('协作测试'));
  provA.awareness.setLocalStateField('user', { name: 'A', color: '#123456', colorLight: '#12345633' });

  // ── GUEST process ──────────────────────────────────────────
  const child = spawn(process.execPath, [path.join(__dirname, 'test-collab-guest.cjs')], {
    env: { ...process.env, HOST_PORT: String(hostRes.wsPort), ROOM_ID: hostRes.roomId },
    cwd: root,
  });
  let guestOut = '';
  child.stdout.on('data', (d) => { guestOut += d; });
  child.stderr.on('data', (d) => process.stdout.write(`[guest] ${d}`));

  // Wait until the guest has joined + published its own asset, then interact
  await new Promise((resolve) => {
    const tick = () => (guestOut.includes('===GUEST_JOINED===') ? resolve() : setTimeout(tick, 100));
    tick();
  });

  // ── host → guest asset ─────────────────────────────────────
  const hostAsset = path.join(hostProj, 'from-host.txt');
  fs.writeFileSync(hostAsset, 'hello from host');
  await sleep(100);
  await handlers.get('collab:publish')(null, [hostAsset]);

  // ── concurrent CRDT edits (A while B is live) ──────────────
  textA.insert(0, '[A]');

  const guest = await new Promise((resolve) => {
    child.on('exit', () => {
      const m = guestOut.match(/===GUEST_RESULT===([\s\S]+)/);
      resolve(m ? JSON.parse(m[1].trim()) : { fatal: 'no result marker' });
    });
  });

  check('guest discovered room via UDP', guest.discovered);
  check('guest join ok', guest.joinOk, guest.joinError || '');
  check('guest mirror has main.tex', (guest.mirrorMainTex || '').includes('协作测试'));
  check('guest mirror has subfile', guest.mirrorHasSub);

  // host should now see the room still active with itself as host
  const state = await handlers.get('collab:state')(null);
  check('host room active', state.active && state.role === 'host');

  check('guest received host asset', guest.hostAssetReceived);
  check('host received guest asset', fs.existsSync(path.join(hostProj, 'figs', 'test.png'))
    && fs.readFileSync(path.join(hostProj, 'figs', 'test.png'), 'utf-8').includes('FAKE-PNG-FROM-GUEST'));

  // ── concurrent CRDT edits ──────────────────────────────────
  const t0 = Date.now();
  while (Date.now() - t0 < 8000 && !textA.toString().includes('[B]')) await sleep(200);
  check('concurrent inserts merged on A', textA.toString().includes('[A]') && textA.toString().includes('[B]'), JSON.stringify(textA.toString()));
  check('guest final text converged', guest.finalText === textA.toString(), JSON.stringify(guest.finalText || ''));
  check('awareness: guest sees host user', (guest.awarenessPeers || []).includes('A'));

  // ── teardown ───────────────────────────────────────────────
  const leave = await handlers.get('collab:leave')(null);
  check('leave ok', leave.ok);
  await sleep(300);
  const stateAfter = await handlers.get('collab:state')(null);
  check('room torn down', stateAfter.active === false);

  fs.rmSync(hostProj, { recursive: true, force: true });
  console.log(failures === 0 ? '\n🎉 ALL PASS' : `\n💥 ${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
