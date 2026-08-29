// ─── LAN collaboration: shared project folder (host + guests) ────
//
// Model: the host's project directory is THE shared folder. Guests get a
// local mirror under Documents; every non-artifact file — main .tex, images,
// cls, subfiles — syncs as whole-file ops through the host, which relays them
// to the other guests. Edits from any source (typing in the editor, external
// tools like Claude Code, files dropped into the folder) all travel the same
// path: local file watcher → publish → host → broadcast → apply + local
// watcher echo-suppressed. No versioning, no merge: last write wins, per the
// product decision that concurrent edits to one file are out of scope.
//
// Each machine compiles locally with its own TeX — the PDF is never synced.
//
// Wire: one WebSocket port (48712+), single /control endpoint, JSON frames.
//   hello {name, rejoin?} → welcome {files:[{p,b64}]} | rejoined
//   file  {p, b64|null, from}   (b64 null = delete)
//   peers {peers:[{id,name,role}]} / bye / ping→pong
// Discovery: host UDP-broadcasts a beacon (magic LLTX1) every 1.5s on 48713.

const { ipcMain, app, shell } = require('electron');
const dgram = require('dgram');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { log } = require('./logger');

const DISC_PORT = 48713;
const DISC_MAGIC = 'LLTX1';
const WS_PORT_MIN = 48712;
const WS_PORT_MAX = 48740;
const BEACON_INTERVAL = 1500;
const ROOM_TTL = 6000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const ARTIFACT_RE = /\.(pdf|log|aux|out|toc|lof|lot|bbl|blg|fls|fdb_latexmk|synctex\.gz|bcf|run\.xml|xyc|dvi)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', 'out', 'dist', '.vscode', '__pycache__', 'sync']);

// `room` is non-null while a collaboration session is active (either role).
let room = null;
let discSocket = null;
let roomsSeen = new Map();
let roomsPushTimer = null;
let opts = { getWin: () => null, setLastSaved: () => {}, store: null };

const randId = (n) => crypto.randomBytes(n).toString('hex').slice(0, n);
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

function sendToRenderer(channel, payload) {
  const win = opts.getWin();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ─── File helpers ────────────────────────────────────────────────

function collectProjectFiles(rootDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name.toLowerCase())) walk(path.join(dir, ent.name));
        continue;
      }
      if (ARTIFACT_RE.test(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      out.push({ rel: path.relative(rootDir, abs).split(path.sep).join('/'), abs });
    }
  };
  walk(rootDir);
  return out;
}

function safeRelPath(rel) {
  if (typeof rel !== 'string' || !rel.length) return null;
  if (rel.includes('\\') || rel.includes(':') || rel.startsWith('/')) return null;
  const parts = rel.split('/');
  if (parts.some((p) => !p.length || p === '.' || p === '..')) return null;
  return path.join(...parts);
}

// Apply a remote file op to disk. b64 null = delete. The resulting bytes'
// hash (null for deletes) is recorded so our own watcher doesn't echo the
// write back onto the network (loop prevention). The main .tex is never
// deleted — losing the host's real file to a stray guest delete is worse
// than a stale copy.
function applyFileOp(baseDir, rel, b64, mainFile) {
  const relOk = safeRelPath(rel);
  if (!relOk) return { ok: false, error: 'bad path' };
  const abs = path.join(baseDir, relOk);
  const isMain = rel === mainFile;
  if (b64 === null || b64 === undefined) {
    if (isMain) return { ok: false, error: 'refusing to delete main file' };
    try { fs.rmSync(abs, { force: true }); } catch {}
    room && room.echo.set(abs, { hash: null, ts: Date.now() });
    return { ok: true, abs };
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_FILE_BYTES) return { ok: false, error: 'too large' };
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    room && room.echo.set(abs, { hash: md5(buf), ts: Date.now() });
    return { ok: true, abs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Decide which locally-changed paths should be published: not build
// artifacts, and not files whose current on-disk bytes match what we just
// wrote from a remote op (watcher echo). ENOENT means the file was deleted
// — publish a delete op unless the echo says we deleted it ourselves.
function filterPublishable(paths, baseDir) {
  const now = Date.now();
  for (const [k, v] of room.echo) if (now - v.ts > 15000) room.echo.delete(k);
  const out = [];
  for (const p of paths || []) {
    if (!p) continue;
    const abs = path.resolve(p);
    if (ARTIFACT_RE.test(path.basename(abs))) continue;
    let content = null;
    let missing = false;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      content = fs.readFileSync(abs);
    } catch (e) {
      if (e.code !== 'ENOENT') continue;
      missing = true;
    }
    const hash = missing ? null : md5(content);
    const seen = room.echo.get(abs);
    if (seen && seen.hash === hash) { room.echo.delete(abs); continue; }
    try {
      const rel = path.relative(baseDir, abs).split(path.sep).join('/');
      if (!safeRelPath(rel)) continue;
      if (missing && rel === room.mainFile) continue; // never delete the main tex
      out.push({ rel, b64: missing ? null : content.toString('base64') });
    } catch { continue; }
  }
  return out;
}

// ─── UDP discovery ───────────────────────────────────────────────

function broadcastTargets() {
  const targets = new Set(['127.0.0.1', '255.255.255.255']);
  const ipToInt = (s) => s.split('.').reduce((a, o) => (a << 8) + Number(o), 0);
  const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      try {
        const ip = ipToInt(ni.address);
        const mask = ipToInt(ni.netmask);
        targets.add(intToIp((ip | (~mask >>> 0)) >>> 0));
      } catch {}
    }
  }
  return [...targets];
}

function startDiscovery() {
  if (discSocket) return;
  try {
    discSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    discSocket.on('error', (e) => {
      log('WARN', `[collab] discovery socket error: ${e.message}`);
      try { discSocket.close(); } catch {}
      discSocket = null;
    });
    discSocket.on('message', (msg, rinfo) => {
      try {
        const str = msg.toString('utf8');
        if (!str.startsWith(DISC_MAGIC)) return;
        const info = JSON.parse(str.slice(DISC_MAGIC.length));
        if (!info.id || !info.wsPort) return;
        if (room && room.role === 'host' && info.id === room.id) return;
        roomsSeen.set(info.id, {
          id: info.id, name: info.name || '未命名房间', wsPort: info.wsPort,
          addr: rinfo.address, hostUser: info.hostUser || '', mainFile: info.mainFile || '',
          lastSeen: Date.now(),
        });
        if (!roomsPushTimer) {
          roomsPushTimer = setTimeout(() => {
            roomsPushTimer = null;
            sendToRenderer('collab:rooms', listRooms());
          }, 600);
        }
      } catch {}
    });
    discSocket.bind(DISC_PORT, () => {
      try { discSocket.setBroadcast(true); } catch {}
      log('INFO', `[collab] discovery listening on :${DISC_PORT}`);
    });
  } catch (e) {
    log('WARN', `[collab] discovery unavailable: ${e.message}`);
    discSocket = null;
  }
}

function stopDiscovery() {
  if (!discSocket) return;
  try { discSocket.close(); } catch {}
  discSocket = null;
}

function listRooms() {
  const now = Date.now();
  const alive = [];
  for (const [id, r] of roomsSeen) {
    if (now - r.lastSeen > ROOM_TTL) roomsSeen.delete(id);
    else alive.push(r);
  }
  return alive.sort((a, b) => b.lastSeen - a.lastSeen);
}

// ─── Control protocol (host side) ────────────────────────────────

function peersList() {
  const peers = [{ id: 'host', name: room.userName, role: 'host' }];
  for (const g of room.guests.values()) peers.push({ id: g.id, name: g.name, role: 'guest' });
  return peers;
}

function broadcastControl(msg, except) {
  const data = JSON.stringify(msg);
  for (const conn of room.guests.keys()) if (conn !== except) wsSend(conn, data);
}

function broadcastPeers() {
  broadcastControl({ t: 'peers', peers: peersList() });
  sendToRenderer('collab:peers', peersList());
}

function hostSnapshot() {
  return collectProjectFiles(path.dirname(room.hostPath)).map((f) => ({
    p: f.rel,
    b64: fs.readFileSync(f.abs).toString('base64'),
  }));
}

function wsSend(conn, data) {
  try { conn.send(data, {}, (err) => { if (err) conn.terminate(); }); }
  catch { try { conn.terminate(); } catch {} }
}

function setupControlConn(conn) {
  conn.on('error', () => {});
  conn.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    const guest = room.guests.get(conn);
    if (guest) guest.lastSeen = Date.now();

    switch (m.t) {
      case 'hello': {
        if (guest) break; // already joined on this conn
        const g = { id: randId(8), name: String(m.name || '队友').slice(0, 32), lastSeen: Date.now() };
        room.guests.set(conn, g);
        if (m.rejoin) {
          // Reconnect of a known guest: skip the snapshot, the file ops that
          // matter will flow as usual from here on.
          log('INFO', `[collab] guest rejoined: ${g.name} (${g.id})`);
          wsSend(conn, JSON.stringify({
            t: 'rejoined', roomId: room.id, roomName: room.name,
            hostName: room.userName, mainFile: path.basename(room.hostPath),
          }));
        } else {
          log('INFO', `[collab] guest joined: ${g.name} (${g.id})`);
          wsSend(conn, JSON.stringify({
            t: 'welcome', roomId: room.id, roomName: room.name,
            hostName: room.userName, mainFile: path.basename(room.hostPath),
            files: hostSnapshot(),
          }));
        }
        broadcastPeers();
        break;
      }
      case 'file': {
        // guest → host: apply locally, relay to everyone else
        const res = applyFileOp(path.dirname(room.hostPath), m.p, m.b64, room.mainFile);
        if (res.ok) {
          broadcastControl({ t: 'file', p: m.p, b64: m.b64, from: guest ? guest.id : '?' }, conn);
          log('INFO', `[collab] file ${m.b64 == null ? 'delete' : 'update'} from ${guest ? guest.name : '?'}: ${m.p}`);
        } else {
          log('WARN', `[collab] file op rejected (${m.p}): ${res.error}`);
        }
        break;
      }
      case 'ping': wsSend(conn, JSON.stringify({ t: 'pong' })); break;
      case 'leave': try { conn.terminate(); } catch {} break;
    }
  });

  conn.on('close', () => {
    if (!room || room.role !== 'host') return;
    const g = room.guests.get(conn);
    if (g) {
      log('INFO', `[collab] guest left: ${g.name} (${g.id})`);
      room.guests.delete(conn);
      broadcastPeers();
    }
  });
}

// Sweep guests that stopped pinging (crashed machine, Wi-Fi drop)
function startGuestSweep() {
  room.guestSweep = setInterval(() => {
    const now = Date.now();
    for (const [conn, g] of room.guests) {
      if (now - g.lastSeen > 45000) {
        log('WARN', `[collab] guest timed out: ${g.name}`);
        try { conn.terminate(); } catch {}
      }
    }
  }, 15000);
}

function startBeacon() {
  room.udpSocket = dgram.createSocket({ type: 'udp4' });
  room.udpSocket.on('error', () => {});
  try { room.udpSocket.setBroadcast(true); } catch {}
  const payload = () => Buffer.from(DISC_MAGIC + JSON.stringify({
    id: room.id, name: room.name, wsPort: room.wsPort,
    hostUser: room.userName, mainFile: path.basename(room.hostPath), ts: Date.now(),
  }));
  room.udpTimer = setInterval(() => {
    const buf = payload();
    for (const target of broadcastTargets()) {
      try { room.udpSocket.send(buf, DISC_PORT, target); } catch {}
    }
  }, BEACON_INTERVAL);
}

// ─── Host lifecycle ──────────────────────────────────────────────

async function startHost(filePath, content, userName) {
  const hostPath = path.resolve(filePath);

  // Collaborative editing writes straight to the real file — flush whatever
  // the editor holds first so disk is the single source of truth.
  try { fs.writeFileSync(hostPath, content, 'utf-8'); opts.setLastSaved(content); } catch {}

  room = {
    role: 'host', id: randId(6), name: path.basename(hostPath), wsPort: 0,
    hostPath, mainFile: path.basename(hostPath),
    userName: String(userName || '主机').slice(0, 32),
    guests: new Map(), echo: new Map(),
    httpServer: null, wssControl: null,
    udpSocket: null, udpTimer: null, guestSweep: null,
  };

  room.httpServer = http.createServer((_req, res) => { res.end('LiveLaTeX collab'); });
  room.wssControl = new WebSocketServer({ noServer: true });
  room.wssControl.on('connection', setupControlConn);
  room.httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/control') room.wssControl.handleUpgrade(req, socket, head, (c) => room.wssControl.emit('connection', c, req));
    else socket.destroy();
  });

  for (let port = WS_PORT_MIN; port <= WS_PORT_MAX; port++) {
    try {
      await new Promise((resolve, reject) => {
        room.httpServer.once('error', reject);
        room.httpServer.listen(port, '0.0.0.0', () => {
          room.httpServer.removeListener('error', reject);
          resolve();
        });
      });
      room.wsPort = port;
      break;
    } catch {}
  }
  if (!room.wsPort) { teardown('host'); return { ok: false, error: '没有可用端口' }; }

  startBeacon();
  startGuestSweep();
  stopDiscovery(); // host doesn't scan while hosting (frees the UDP port for guests)
  log('INFO', `[collab] hosting "${room.name}" as ws://0.0.0.0:${room.wsPort} (room ${room.id})`);
  sendToRenderer('collab:status', { state: 'hosting', roomId: room.id, roomName: room.name, wsPort: room.wsPort });
  return { ok: true, role: 'host', roomId: room.id, roomName: room.name, wsPort: room.wsPort };
}

// ─── Guest lifecycle ─────────────────────────────────────────────

function connectCtl(addr, wsPort, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${addr}:${wsPort}/control`);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch {}
      reject(new Error('连接主机超时'));
    }, timeoutMs);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function mirrorDirFor(roomName, roomId) {
  let base;
  try { base = app.getPath('documents'); } catch { base = os.homedir(); }
  const safe = roomName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'room';
  return path.join(base, 'LiveLaTeX-Collab', `${safe}-${roomId}`);
}

function attachCtlHandlers(ws, onMessage) {
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    if (room && room.role === 'guest') room.lastCtl = Date.now();
    onMessage && onMessage(m);
    if (!room || room.role !== 'guest') return;
    switch (m.t) {
      case 'peers': sendToRenderer('collab:peers', m.peers || []); break;
      case 'file': {
        const res = applyFileOp(room.mirrorDir, m.p, m.b64, room.mainFile);
        if (!res.ok) log('WARN', `[collab] file op failed (${m.p}): ${res.error}`);
        break;
      }
      case 'bye': {
        log('INFO', '[collab] host closed the room');
        sendToRenderer('collab:closed', { reason: '主机已关闭房间' });
        teardownGuest();
        break;
      }
    }
  });
  ws.on('close', () => {
    // Only the CURRENT control connection may trigger a reconnect — a
    // superseded socket closing later must not double-dial.
    if (room && room.role === 'guest' && room.ctl === ws) scheduleGuestReconnect();
  });
  ws.on('error', () => {});
}

function scheduleGuestReconnect() {
  if (!room || room.role !== 'guest' || room.stopped) return;
  if (room.rejoinTimer) return;
  sendToRenderer('collab:status', { state: 'reconnecting', roomName: room.roomName });
  room.rejoinTimer = setTimeout(async () => {
    room.rejoinTimer = null;
    if (!room || room.role !== 'guest' || room.stopped) return;
    try {
      const ws = await connectCtl(room.hostAddr, room.wsPort);
      room.ctl = ws;
      attachCtlHandlers(ws, (m) => { if (m.t === 'rejoined') sendToRenderer('collab:status', { state: 'connected', roomName: room.roomName }); });
      ws.send(JSON.stringify({ t: 'hello', name: room.userName, rejoin: true, roomId: room.roomId }));
    } catch {
      scheduleGuestReconnect();
    }
  }, 3000);
}

async function joinRoom({ addr, wsPort, name }) {
  const ctl = await connectCtl(addr, wsPort);
  const welcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('主机无响应（快照接收超时）')), 120000);
    const onMsg = (data) => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.t === 'welcome') { cleanup(); resolve(m); }
      else if (m.t === 'error') { cleanup(); reject(new Error(m.error || '加入失败')); }
    };
    const cleanup = () => { clearTimeout(timer); try { ctl.off('message', onMsg); } catch {} };
    ctl.on('message', onMsg);
    ctl.send(JSON.stringify({ t: 'hello', name: String(name || '队友').slice(0, 32) }));
  });

  // Materialize the project mirror locally so this machine can compile —
  // this folder IS the user's copy: they can open it, drop files in, point
  // external tools at it; everything syncs back through the host.
  const mirrorDir = mirrorDirFor(welcome.roomName, welcome.roomId);
  fs.rmSync(mirrorDir, { recursive: true, force: true });
  fs.mkdirSync(mirrorDir, { recursive: true });
  for (const f of welcome.files || []) {
    const rel = safeRelPath(f.p);
    if (!rel) continue;
    const abs = path.join(mirrorDir, rel);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(f.b64, 'base64'));
    } catch (e) {
      log('WARN', `[collab] mirror write failed ${f.p}: ${e.message}`);
    }
  }
  const mainPath = path.join(mirrorDir, safeRelPath(welcome.mainFile) || 'main.tex');

  room = {
    role: 'guest', id: welcome.roomId, roomId: welcome.roomId,
    roomName: welcome.roomName, hostName: welcome.hostName,
    hostAddr: addr, wsPort, userName: String(name || '队友').slice(0, 32),
    mirrorDir, mainPath, mainFile: welcome.mainFile,
    ctl, echo: new Map(), stopped: false, rejoinTimer: null, lastCtl: Date.now(),
  };
  attachCtlHandlers(ctl, null);

  // heartbeat so the host notices a dead guest quickly
  room.pingTimer = setInterval(() => {
    try { room.ctl.send(JSON.stringify({ t: 'ping' })); } catch {}
  }, 10000);

  log('INFO', `[collab] joined "${welcome.roomName}" @ ${addr}:${wsPort}, mirror at ${mirrorDir}`);
  sendToRenderer('collab:status', { state: 'connected', roomName: room.roomName, role: 'guest' });
  return {
    ok: true, role: 'guest', filePath: mainPath, projectDir: mirrorDir,
    roomName: welcome.roomName, hostName: welcome.hostName, roomId: welcome.roomId, addr, wsPort,
  };
}

// ─── Teardown ────────────────────────────────────────────────────

function teardownHost(reason) {
  if (!room || room.role !== 'host') return;
  broadcastControl({ t: 'bye' });
  for (const conn of room.guests.keys()) { try { conn.terminate(); } catch {} }
  clearInterval(room.udpTimer);
  clearInterval(room.guestSweep);
  try { room.udpSocket.close(); } catch {}
  try { room.wssControl.close(); } catch {}
  try { room.httpServer.close(); } catch {}
  log('INFO', `[collab] room closed (${reason || 'local'})`);
  room = null;
  startDiscovery();
  sendToRenderer('collab:status', { state: 'idle' });
}

function teardownGuest() {
  if (!room || room.role !== 'guest') return;
  room.stopped = true;
  clearInterval(room.pingTimer);
  clearTimeout(room.rejoinTimer);
  try { if (room.ctl.readyState === WebSocket.OPEN) room.ctl.send(JSON.stringify({ t: 'leave' })); } catch {}
  try { room.ctl.close(); } catch {}
  log('INFO', '[collab] left room');
  room = null;
  sendToRenderer('collab:status', { state: 'idle' });
}

// ─── IPC ─────────────────────────────────────────────────────────

function initCollab(opts_) {
  opts = opts_;
  startDiscovery();

  ipcMain.handle('collab:start-host', async (_e, filePath, content, userName) => {
    if (!filePath) return { ok: false, error: '请先打开一个 .tex 文件' };
    if (room) return { ok: false, error: room.role === 'host' ? '你已在主持房间' : '你已在一个协作房间中，请先退出' };
    try {
      return await startHost(filePath, content, userName);
    } catch (e) {
      log('ERROR', `[collab] start-host failed: ${e.message}`);
      if (room) teardownHost('error');
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('collab:join', async (_e, args) => {
    if (room) return { ok: false, error: room.role === 'host' ? '你已在主持房间，请先关闭' : '你已在一个协作房间中' };
    const addr = String(args?.addr || '').trim();
    const wsPort = parseInt(args?.wsPort, 10);
    if (!addr || !wsPort) return { ok: false, error: '地址无效' };
    try {
      return await joinRoom({ addr, wsPort, name: args?.name });
    } catch (e) {
      log('ERROR', `[collab] join failed: ${e.message}`);
      if (room) teardownGuest();
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('collab:leave', () => {
    if (!room) return { ok: true };
    if (room.role === 'host') teardownHost('leave');
    else teardownGuest();
    return { ok: true };
  });

  // Renderer noticed local project files change (via the existing source
  // watcher): ship them to the network. Host relays to other guests, guests
  // send to the host. b64 null encodes a deletion.
  ipcMain.handle('collab:publish', (_e, paths) => {
    if (!room) return { ok: false };
    const baseDir = room.role === 'host' ? path.dirname(room.hostPath) : room.mirrorDir;
    const ops = filterPublishable(paths, baseDir);
    for (const op of ops) {
      if (room.role === 'host') {
        broadcastControl({ t: 'file', p: op.rel, b64: op.b64, from: 'host' });
      } else {
        try { room.ctl.send(JSON.stringify({ t: 'file', p: op.rel, b64: op.b64, from: room.id })); } catch {}
      }
    }
    if (ops.length) log('INFO', `[collab] published ${ops.length} file op(s): ${ops.map((o) => o.rel).join(', ')}`);
    return { ok: true, count: ops.length };
  });

  ipcMain.handle('collab:rooms-now', () => listRooms());
  ipcMain.handle('collab:state', () => room ? {
    active: true, role: room.role, roomId: room.id,
    roomName: room.role === 'host' ? room.name : room.roomName,
    wsPort: room.wsPort || 0,
    hostAddr: room.role === 'guest' ? `${room.hostAddr}:${room.wsPort}` : '',
    projectDir: room.role === 'host' ? path.dirname(room.hostPath) : room.mirrorDir,
    filePath: room.role === 'host' ? room.hostPath : room.mainPath,
  } : { active: false });

  ipcMain.handle('app:open-path', async (_e, dirPath) => {
    if (!dirPath || !fs.existsSync(dirPath)) return { ok: false, error: '路径不存在' };
    const res = await shell.openPath(dirPath);
    return res ? { ok: false, error: res } : { ok: true };
  });
}

function shutdownCollab() {
  if (room) {
    if (room.role === 'host') teardownHost('quit');
    else teardownGuest();
  }
  stopDiscovery();
}

module.exports = { initCollab, shutdownCollab };
