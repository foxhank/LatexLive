// ─── Renderer-side collaboration ─────────────────────────────────
//
// The renderer is a plain y-websocket client — host and guests run the same
// code, pointed at ws://127.0.0.1 (host) or the LAN address (guests).
// Owns: provider lifecycle, CodeMirror binding, CRDT→disk autosave,
// the room modal / status chip / peer list UI.

import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { yCollab } from 'y-codemirror.next';

const $ = (id) => document.getElementById(id);

const USER_COLORS = [
  ['#30bced', '#30bced33'], ['#6eeb83', '#6eeb8333'], ['#ffbc42', '#ffbc4233'],
  ['#ecd444', '#ecd44433'], ['#ee6352', '#ee635233'], ['#9b5de5', '#9b5de533'],
];

export const collab = {
  active: false,
  role: null,           // 'host' | 'guest'
  roomId: null,
  roomName: '',
  hostAddr: '',         // display string for guests
  localPath: null,      // file the CRDT autosaves to (host original / guest mirror)
  ydoc: null,
  provider: null,
  awareness: null,
  ytext: null,
  undoManager: null,
  syncedOnce: false,
  peers: [],
  userName: '',
  colorIdx: Math.floor(Math.random() * USER_COLORS.length),
  saveTimer: null,
};

// hooks wired up by main.ts so this module never touches editor internals
let hooks = null;

export function isCollabActive() { return collab.active; }

export function setupCollab(hooks_) {
  hooks = hooks_;
  setupUI();
  window.api.on('collab:rooms', (rooms) => renderRooms(rooms || []));
  window.api.on('collab:peers', (peers) => { collab.peers = peers || []; renderPeers(); updateChip(); });
  window.api.on('collab:status', (s) => {
    if (!collab.active) return;
    if (s.state === 'reconnecting') setMsg(`与主机断开，正在重连 ${s.roomName || ''}…`, true);
    if (s.state === 'connected') setMsg('已连接到房间 ✓');
  });
  window.api.on('collab:closed', (p) => {
    if (collab.active) leaveCollab(`已退出协作：${p?.reason || '房间已关闭'}`);
  });
}

// ─── Editor integration ─────────────────────────────────────────

export function getCollabExtensions() {
  return [yCollab(collab.ytext, collab.awareness, { undoManager: collab.undoManager })];
}

function colorPair() { return USER_COLORS[collab.colorIdx % USER_COLORS.length]; }

function setLocalUserField() {
  const [color, colorLight] = colorPair();
  collab.awareness.setLocalStateField('user', {
    name: collab.userName || (collab.role === 'host' ? '主机' : '队友'),
    color, colorLight,
  });
}

function connectProvider(addr, wsPort, roomId) {
  collab.ydoc = new Y.Doc();
  collab.provider = new WebsocketProvider(`ws://${addr}:${wsPort}`, roomId, collab.ydoc);
  collab.awareness = collab.provider.awareness;
  setLocalUserField();
  collab.ytext = collab.ydoc.getText('content');
  collab.undoManager = new Y.UndoManager(collab.ytext);
  collab.syncedOnce = false;

  collab.provider.on('sync', (synced) => {
    if (synced && !collab.syncedOnce) {
      collab.syncedOnce = true;
      // First full sync may have brought remote content — compile once now
      hooks.scheduleCompile();
    }
  });
  collab.provider.on('status', ({ status }) => {
    if (!collab.active) return;
    if (status === 'disconnected') setMsg('同步通道断开，正在自动重连…', true);
    else if (status === 'connected') setMsg('同步通道已连接 ✓');
  });

  // CRDT → disk autosave (host original / guest mirror). file:save also
  // updates the main process's echo baseline, so the file watcher won't
  // treat our own write as an external edit.
  collab.ydoc.on('update', () => {
    if (!collab.active || !collab.localPath) return;
    clearTimeout(collab.saveTimer);
    collab.saveTimer = setTimeout(() => {
      window.api.file.save(collab.ytext.toString(), collab.localPath).then(() => {
        const app = hooks.getAppState();
        if (app.modified) { app.modified = false; hooks.updateModified(); }
      }).catch(() => {});
    }, 500);
  });
}

export function flushCollabSave() {
  if (collab.active && collab.localPath && collab.ytext) {
    return window.api.file.save(collab.ytext.toString(), collab.localPath);
  }
  return Promise.resolve();
}

// Editor content source of truth while collaborating
export function getDocContent() {
  return collab.active && collab.ytext ? collab.ytext.toString() : null;
}

// Called from main.ts's `source:changed` handler instead of the default
// content-swap path: in collab mode the editor is CRDT-bound, disk content
// for the main file must never be pushed into it.
export async function handleSourceChanged(payload) {
  const changed = (payload?.changedPaths || [])
    .filter((p) => p && pathResolve(p) !== pathResolve(collab.localPath));
  if (changed.length) await window.api.collab.publish(changed);
  hooks.scheduleCompile();
}

function pathResolve(p) { return p.replace(/[/\\]+/g, '/').toLowerCase(); }

// ─── Enter / leave ──────────────────────────────────────────────

async function enterRoom(result) {
  collab.active = true;
  collab.role = result.role;
  collab.roomId = result.roomId;
  collab.roomName = result.roomName;
  collab.hostAddr = result.addr ? `${result.addr}:${result.wsPort}` : `本机:${result.wsPort}`;
  collab.localPath = result.filePath;
  connectProvider(result.addr || '127.0.0.1', result.wsPort, result.roomId);

  const app = hooks.getAppState();
  app.currentFilePath = result.filePath;
  app.modified = false;
  hooks.updateModified();
  hooks.updatePathUI(result.filePath);
  window.api.watcher.watchSource(result.filePath);
  hooks.rebuildEditor();
  hooks.runCompile();
  closeCollabModal();
}

export async function startHost() {
  const app = hooks.getAppState();
  if (!app.currentFilePath) { setMsg('请先打开一个 .tex 文件再创建房间', true); return; }
  saveName();
  setMsg('正在创建房间…');
  const res = await window.api.collab.startHost(app.currentFilePath, hooks.getEditorContent(), collab.userName);
  if (!res.ok) { setMsg(`创建失败：${res.error}`, true); return; }
  await enterRoom({ role: 'host', roomId: res.roomId, roomName: res.roomName, wsPort: res.wsPort, filePath: app.currentFilePath });
  setMsg(`房间已创建 ✓ 把「${collab.hostAddr}」告诉队友即可加入`);
}

export async function joinRoom(entry) {
  saveName();
  setMsg(`正在加入 ${entry.addr}:${entry.wsPort} …`);
  const res = await window.api.collab.join({ addr: entry.addr, wsPort: entry.wsPort, name: collab.userName });
  if (!res.ok) { setMsg(`加入失败：${res.error}`, true); return; }
  await enterRoom(res);
  setMsg(`已加入「${res.roomName}」（主持人：${res.hostName}）✓`);
}

export function leaveCollab(reason) {
  clearTimeout(collab.saveTimer);
  flushCollabSave().catch(() => {});
  try { collab.provider && collab.provider.destroy(); } catch {}
  try { collab.ydoc && collab.ydoc.destroy(); } catch {}
  collab.provider = collab.ydoc = collab.awareness = collab.ytext = collab.undoManager = null;
  collab.active = false;
  collab.peers = [];
  window.api.collab.leave();

  const app = hooks.getAppState();
  app.modified = false;
  hooks.rebuildEditor();
  updateChip();
  renderPeers();
  setMsg(reason || '已退出协作');
  showIdleView();
}

// ─── UI ─────────────────────────────────────────────────────────

function saveName() {
  collab.userName = ($('collab-name').value || '').trim().slice(0, 32);
  window.api.settings.set('userName', collab.userName);
}

function setMsg(text, isSticky) {
  const el = $('collab-msg');
  el.textContent = text || '';
  el.classList.toggle('collab-msg-error', !!isSticky);
}

function updateChip() {
  const chip = $('collab-chip');
  if (!collab.active) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  chip.textContent = `👥 ${collab.roomName} · ${Math.max(collab.peers.length, 1)}人`;
  chip.title = `协作中（${collab.role === 'host' ? '主持人' : '成员'}）· 点击查看`;
}

function renderRooms(rooms) {
  const box = $('collab-rooms');
  if (collab.active) return;
  if (!rooms.length) {
    box.innerHTML = '<div class="collab-empty">未发现房间——让队友点「创建房间」，或用下方 IP 手动加入</div>';
    return;
  }
  box.innerHTML = '';
  rooms.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'collab-room-row';
    const info = document.createElement('div');
    info.className = 'collab-room-info';
    info.innerHTML = `<span class="collab-room-name"></span><span class="collab-room-meta"></span>`;
    info.querySelector('.collab-room-name').textContent = `${r.name}`;
    info.querySelector('.collab-room-meta').textContent = `${r.hostUser || '主机'} @ ${r.addr}`;
    const btn = document.createElement('button');
    btn.textContent = '加入';
    btn.addEventListener('click', () => joinRoom(r));
    row.appendChild(info);
    row.appendChild(btn);
    box.appendChild(row);
  });
}

function renderPeers() {
  const box = $('collab-peers');
  box.innerHTML = '';
  const peers = collab.peers.length ? collab.peers : [{ id: 'me', name: collab.userName, role: collab.role }];
  peers.forEach((p, i) => {
    const item = document.createElement('span');
    item.className = 'collab-peer';
    const [color] = USER_COLORS[(collab.colorIdx + i) % USER_COLORS.length];
    item.innerHTML = `<span class="collab-peer-dot"></span><span class="collab-peer-name"></span>`;
    item.querySelector('.collab-peer-dot').style.background = color;
    item.querySelector('.collab-peer-name').textContent = p.name + (p.role === 'host' ? '（主持人）' : '');
    box.appendChild(item);
  });
}

function showIdleView() {
  $('collab-idle-view').classList.remove('hidden');
  $('collab-active-view').classList.add('hidden');
}

function showActiveView() {
  $('collab-idle-view').classList.add('hidden');
  $('collab-active-view').classList.remove('hidden');
  $('collab-room-info').textContent =
    `房间「${collab.roomName}」 · ${collab.role === 'host' ? '你是主持人，地址 ' + collab.hostAddr : '主持人 ' + (collab.hostName || '') + ' @ ' + collab.hostAddr}`;
  renderPeers();
}

function openCollabModal() {
  setMsg('');
  if (collab.active) showActiveView(); else showIdleView();
  $('collab-modal').classList.remove('hidden');
  if (!collab.active) window.api.collab.roomsNow().then(renderRooms);
}

function closeCollabModal() { $('collab-modal').classList.add('hidden'); }

function setupUI() {
  window.api.settings.get().then((s) => {
    collab.userName = (s && s.userName) || '';
    $('collab-name').value = collab.userName;
  });
  $('btn-collab').addEventListener('click', openCollabModal);
  $('collab-chip').addEventListener('click', openCollabModal);
  $('collab-close').addEventListener('click', closeCollabModal);
  $('collab-modal').querySelector('.modal-backdrop').addEventListener('click', closeCollabModal);
  $('btn-collab-host').addEventListener('click', () => startHost());
  $('btn-collab-leave').addEventListener('click', () => leaveCollab());
  $('btn-collab-manual').addEventListener('click', () => {
    const raw = ($('collab-manual').value || '').trim();
    const m = raw.match(/^(?:ws:\/\/)?\[?([0-9a-zA-Z.:_-]+?)\]?:(\d+)$/);
    if (!m) { setMsg('地址格式：IP:端口，例如 192.168.1.23:48712', true); return; }
    joinRoom({ addr: m[1], wsPort: parseInt(m[2], 10) });
  });
}
