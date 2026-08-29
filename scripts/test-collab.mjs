// LAN collaboration (shared-folder model) protocol test — headless, two processes.
//
//   this process  = HOST: real collab module (electron stubbed); also plays
//                   the host renderer by invoking collab:publish after touching files
//   child process = GUEST: real collab module (join/mirror/assets), acting as
//                   user + external AI tool editing the local mirror
//
// Verifies: UDP discovery, join+snapshot mirror, guest external main.tex edit →
// host, host main.tex edit → guest, assets both ways, deletion sync, main.tex
// delete protection, and clean teardown. Exits 0 only if every assertion holds.
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
const read = (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } };

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
  check('start-host flushed editor content to disk', read(mainTex).includes('协作测试'));

  // ── GUEST process ──────────────────────────────────────────
  const child = spawn(process.execPath, [path.join(__dirname, 'test-collab-guest.cjs')], {
    env: { ...process.env, HOST_PORT: String(hostRes.wsPort), ROOM_ID: hostRes.roomId },
    cwd: root,
  });
  let guestOut = '';
  child.stdout.on('data', (d) => { guestOut += d; });
  child.stderr.on('data', (d) => process.stdout.write(`[guest] ${d}`));

  // Wait until the guest joined and pushed its own changes, then interact
  await new Promise((resolve) => {
    const tick = () => (guestOut.includes('===GUEST_JOINED===') ? resolve() : setTimeout(tick, 100));
    tick();
  });

  // ── host → guest: asset + external main.tex edit ───────────
  fs.writeFileSync(path.join(hostProj, 'from-host.txt'), 'hello v1');
  fs.appendFileSync(mainTex, '\n% edited-by-host\n');
  await sleep(100);
  await handlers.get('collab:publish')(null, [path.join(hostProj, 'from-host.txt'), mainTex]);

  // Guest needs a moment to observe both, then attempts a main.tex delete +
  // a second image publish. Give it 3s before pushing the v2 asset it waits for.
  await sleep(3000);
  fs.writeFileSync(path.join(hostProj, 'from-host.txt'), 'hello v2');
  await sleep(100);
  await handlers.get('collab:publish')(null, [path.join(hostProj, 'from-host.txt')]);

  const guest = await new Promise((resolve) => {
    child.on('exit', () => {
      const m = guestOut.match(/===GUEST_RESULT===([\s\S]+)/);
      resolve(m ? JSON.parse(m[1].trim()) : { fatal: 'no result marker' });
    });
  });

  // ── guest-side assertions ──────────────────────────────────
  check('guest discovered room via UDP', guest.discovered);
  check('guest join ok', guest.joinOk, guest.joinError || '');
  check('guest mirror has main.tex', (guest.mirrorMainTex || '').includes('协作测试'));
  check('guest mirror has subfile', guest.mirrorHasSub);
  check('guest received host asset', guest.hostAssetReceived);
  check('guest received host main.tex edit', guest.hostTexEditArrived);
  check('room alive after main-tex delete attempt (v2 asset arrived)', guest.secondPublishWorked);

  // ── host-side assertions ───────────────────────────────────
  check('host received guest external main.tex edit', read(mainTex).includes('% edited-by-agent-B'), JSON.stringify(read(mainTex)));
  check('guest main.tex delete REFUSED on host', fs.existsSync(mainTex) && read(mainTex).includes('% edited-by-host'));
  check('host received guest asset', read(path.join(hostProj, 'figs', 'test.png')) === 'FAKE-PNG-SECOND',
    JSON.stringify(read(path.join(hostProj, 'figs', 'test.png'))));
  check('guest file deletion synced to host', !fs.existsSync(path.join(hostProj, 'sections', 'intro.tex')));

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
