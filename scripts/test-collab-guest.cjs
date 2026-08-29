// Guest-side test process. Spawned by test-collab.mjs.
// Joins the host's room through the REAL collab:join handler, then acts like
// a user + an external AI tool working inside the local mirror: edits the
// main tex directly on disk, drops an image in, deletes a file — all synced
// through the real watcher→publish path. Reports results as JSON on stdout.
const path = require('path');
const fs = require('fs');

const HOST_PORT = Number(process.env.HOST_PORT);
const ROOM_ID = process.env.ROOM_ID;

async function main() {
  const out = {};
  const collab = require(path.join(__dirname, '..', 'test-dist', 'collab.cjs'));
  const electronStub = require('./electron-stub.cjs');
  const handlers = electronStub.__collabHandlers;

  collab.initCollab({ getWin: () => null, setLastSaved: () => {}, store: {} });

  // 1. discovery: wait for the host's beacon to show up in the room list
  const t0 = Date.now();
  out.discovered = false;
  while (Date.now() - t0 < 8000) {
    const rooms = await handlers.get('collab:rooms-now')(null);
    if (rooms.some((r) => r.id === ROOM_ID && r.wsPort === HOST_PORT)) { out.discovered = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }

  // 2. join via the real handler
  const join = await handlers.get('collab:join')(null, { addr: '127.0.0.1', wsPort: HOST_PORT, name: '队友B' });
  out.joinOk = join.ok;
  if (!join.ok) { out.joinError = join.error; return finish(out); }
  const mirrorDir = join.projectDir;
  const mainPath = join.filePath;
  out.mirrorMainTex = fs.readFileSync(mainPath, 'utf-8');
  out.mirrorHasSub = fs.existsSync(path.join(mirrorDir, 'sections', 'intro.tex'));

  // 3. simulate the renderer watcher: publish every path the "user" touches.
  // (The real renderer calls collab:publish from source:changed events; here
  // we drive the same IPC handler directly.)
  const publish = async (paths) => handlers.get('collab:publish')(null, paths);

  // 3a. external edit of the main tex (e.g. Claude Code) → must reach the host
  fs.appendFileSync(mainPath, '\n% edited-by-agent-B\n');
  await new Promise((r) => setTimeout(r, 100));
  await publish([mainPath]);

  // 3b. guest → host asset: drop an image AND a PDF figure (the pdf one is a
  // regression test — pdf figures used to be wrongly treated as build debris)
  const imgPath = path.join(mirrorDir, 'figs', 'test.png');
  fs.mkdirSync(path.dirname(imgPath), { recursive: true });
  fs.writeFileSync(imgPath, Buffer.from('FAKE-PNG-FROM-GUEST'));
  const pdfFig = path.join(mirrorDir, 'figs', 'diagram.pdf');
  fs.writeFileSync(pdfFig, Buffer.from('%PDF-1.4 fake figure'));
  await new Promise((r) => setTimeout(r, 100));
  await publish([imgPath, pdfFig]);

  // 3c. guest deletes a file → deletion op
  const doomed = path.join(mirrorDir, 'sections', 'intro.tex');
  fs.rmSync(doomed);
  await new Promise((r) => setTimeout(r, 100));
  await publish([doomed]);

  console.log('===GUEST_JOINED===');

  // 4. wait for host's asset + host's external main.tex edit to arrive
  const t1 = Date.now();
  while (Date.now() - t1 < 10000) {
    const hasAsset = fs.existsSync(path.join(mirrorDir, 'from-host.txt'));
    const hasHostEdit = fs.readFileSync(mainPath, 'utf-8').includes('% edited-by-host');
    if (hasAsset && hasHostEdit) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  out.hostAssetReceived = fs.existsSync(path.join(mirrorDir, 'from-host.txt'));
  out.hostTexEditArrived = fs.readFileSync(mainPath, 'utf-8').includes('% edited-by-host');
  out.mainTexStillExists = fs.existsSync(mainPath);

  // 5. main tex deletion must be refused (never destroy the host's real file)
  fs.rmSync(mainPath);
  await new Promise((r) => setTimeout(r, 100));
  await publish([mainPath]);
  // host should NOT have lost its main.tex — and on the guest side the room
  // still works. Verify by re-publishing a trivial asset afterwards.
  fs.writeFileSync(imgPath, Buffer.from('FAKE-PNG-SECOND'));
  await new Promise((r) => setTimeout(r, 100));
  await publish([imgPath]);
  const t2 = Date.now();
  out.secondPublishWorked = false;
  while (Date.now() - t2 < 6000) {
    if (fs.readFileSync(path.join(mirrorDir, 'from-host.txt'), 'utf-8').includes('v2')) { out.secondPublishWorked = true; break; }
    await new Promise((r) => setTimeout(r, 300));
  }

  finish(out);

  function finish(o) {
    console.log('===GUEST_RESULT===' + JSON.stringify(o));
    setTimeout(() => process.exit(0), 500);
  }
}

main().catch((e) => {
  console.log('===GUEST_RESULT===' + JSON.stringify({ fatal: e.message, stack: String(e.stack).split('\n').slice(0, 4) }));
  process.exit(1);
});
