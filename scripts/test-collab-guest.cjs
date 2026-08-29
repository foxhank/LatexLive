// Guest-side test process. Spawned by test-collab.mjs.
// Joins the host's room through the REAL collab:join handler, verifies the
// project mirror, exchanges assets both ways, joins the CRDT room as a second
// editor, and reports results as JSON on stdout.
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  const mirrorDir = path.dirname(join.filePath);
  out.mirrorMainTex = fs.readFileSync(join.filePath, 'utf-8');
  out.mirrorHasSub = fs.existsSync(path.join(mirrorDir, 'sections', 'intro.tex'));

  // 3. guest → host asset: create an image in the mirror, publish it
  const imgPath = path.join(mirrorDir, 'figs', 'test.png');
  fs.mkdirSync(path.dirname(imgPath), { recursive: true });
  fs.writeFileSync(imgPath, Buffer.from('FAKE-PNG-FROM-GUEST'));
  await new Promise((r) => setTimeout(r, 100)); // let watcher-echo timestamps settle
  await handlers.get('collab:publish')(null, [imgPath]);

  // 4. join the CRDT room as editor B
  const { WebsocketProvider } = require('y-websocket');
  const Y = require('yjs');
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(`ws://127.0.0.1:${HOST_PORT}`, ROOM_ID, ydoc);
  await new Promise((resolve) => {
    if (provider.synced) return resolve();
    provider.on('sync', (s) => s && resolve());
  });
  const text = ydoc.getText('content');
  out.initialTextLength = text.length;

  // signal the parent that join+publish are done — it can now send assets
  // and edits that this process must observe
  console.log('===GUEST_JOINED===');

  // 5. wait for host's asset (b.txt) to arrive in the mirror
  const t1 = Date.now();
  out.hostAssetReceived = false;
  while (Date.now() - t1 < 8000) {
    if (fs.existsSync(path.join(mirrorDir, 'from-host.txt'))) { out.hostAssetReceived = true; break; }
    await new Promise((r) => setTimeout(r, 300));
  }

  // 6. concurrent edit: B types at position 0, then appends own marker
  text.insert(0, '[B]');
  text.insert(text.length, '[B-END]');

  // 7. wait for A's marker to arrive, then report final text
  const t2 = Date.now();
  while (Date.now() - t2 < 8000) {
    if (text.toString().includes('[A]')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  out.finalText = text.toString();
  out.awarenessPeers = [...provider.awareness.getStates().values()]
    .map((s) => s.user && s.user.name).filter(Boolean);

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
