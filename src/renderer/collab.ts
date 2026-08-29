// ─── Renderer-side collaboration: shared project folder ─────────
//
// The editor stays a plain local editor in collab mode. Sync is file-level:
// in-app edits reach the room via debounced autosave → disk → watcher →
// publish; edits from outside (another person's autosave, Claude Code, files
// dropped into the folder) come back through the watcher and are applied to
// the editor unless the user is actively typing. Last write wins.

const $ = (id) => document.getElementById(id);

export const collab = {
  active: false,
  role: null,           // 'host' | 'guest'
  roomId: null,
  roomName: '',
  hostAddr: '',         // display string for guests
  localPath: null,      // main .tex on this machine (host original / guest mirror)
  projectDir: null,     // shared folder on this machine
  peers: [],
  userName: '',
  saveTimer: null,
  lastLocalEditTs: 0,
  pendingRemoteTex: null,
  pendingRemoteTimer: null,
  pendingSince: 0,
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

// ─── Local edits → room ─────────────────────────────────────────

// Called from main.ts's updateListener on every doc change while collab is
// active: records "user is typing" (so incoming remote content doesn't clobber
// the cursor mid-keystroke) and schedules the disk flush that publishes it.
// `publishable` is false during IME composition — intermediate pinyin states
// must update the typing timestamp but not hit the disk / the room.
export function notifyLocalEdit(publishable = true) {
  if (!collab.active) return;
  collab.lastLocalEditTs = Date.now();
  if (!publishable) return;
  clearTimeout(collab.saveTimer);
  collab.saveTimer = setTimeout(() => flushCollabSave().catch(() => {}), 500);
}

export function flushCollabSave() {
  if (collab.active && collab.localPath) {
    return window.api.file.save(hooks.getEditorContent(), collab.localPath).then(() => {
      const app = hooks.getAppState();
      if (app.modified) { app.modified = false; hooks.updateModified(); }
      // Publish the main tex explicitly: our own autosave write is
      // echo-suppressed in the watcher, so source:changed never fires for
      // it — without this, in-app typing would never reach the room.
      return window.api.collab.publish([collab.localPath]);
    });
  }
  return Promise.resolve();
}

// ─── Room edits → editor ────────────────────────────────────────

// Called from main.ts's `source:changed` handler. Publishes every changed /
// deleted path to the room, and applies remote main.tex content to the editor
// (deferred while the user is typing).
export async function handleSourceChanged(payload) {
  const changed = payload?.changedPaths || [];
  const deleted = payload?.deletedPaths || [];
  const all = [...changed, ...deleted].filter(Boolean);
  if (all.length) await window.api.collab.publish(all);

  const mainPathNorm = norm(collab.localPath);
  const mainChanged = changed.some((p) => norm(p) === mainPathNorm);
  if (mainChanged && payload?.content != null) applyRemoteTex(payload.content);

  hooks.scheduleCompile();
}

function applyRemoteTex(content) {
  if (content === hooks.getEditorContent()) { collab.pendingRemoteTex = null; return; }
  collab.pendingRemoteTex = content;
  if (!collab.pendingRemoteTimer) tryApplyPendingTex(0);
}

// Defer applying remote main.tex content while the user is mid-keystroke or
// mid-IME-composition (yanking the doc breaks both cursor and IME). Re-check
// every 400ms; after 10s of continuous local activity, apply anyway so one
// side typing nonstop can't starve the other side's updates forever (LWW).
function tryApplyPendingTex(delay) {
  clearTimeout(collab.pendingRemoteTimer);
  collab.pendingRemoteTimer = setTimeout(() => {
    collab.pendingRemoteTimer = null;
    const c = collab.pendingRemoteTex;
    if (c == null) return;
    if (c === hooks.getEditorContent()) { collab.pendingRemoteTex = null; return; }
    if (!collab.pendingSince) collab.pendingSince = Date.now();
    const composing = hooks.isComposing && hooks.isComposing();
    const recentlyTyped = Date.now() - collab.lastLocalEditTs < 1200;
    if ((composing || recentlyTyped) && Date.now() - collab.pendingSince < 10000) {
      tryApplyPendingTex(400);
      return;
    }
    collab.pendingRemoteTex = null;
    collab.pendingSince = 0;
    hooks.setEditorContent(c);
  }, delay);
}

function norm(p) { return String(p || '').replace(/[/\\]+/g, '/').toLowerCase(); }

// ─── Enter / leave ──────────────────────────────────────────────

async function enterRoom(result) {
  collab.active = true;
  collab.role = result.role;
  collab.roomId = result.roomId;
  collab.roomName = result.roomName;
  collab.hostAddr = result.addr ? `${result.addr}:${result.wsPort}` : `本机:${result.wsPort}`;
  collab.localPath = result.filePath;
  collab.projectDir = result.projectDir || pathDirname(result.filePath);

  const app = hooks.getAppState();
  app.currentFilePath = result.filePath;
  app.modified = false;
  hooks.updateModified();

  // Guest: load the mirrored project's main tex into the (plain) editor.
  // Host: the editor already shows the file we just flushed to disk.
  if (result.role === 'guest') {
    const local = await window.api.file.openPath(result.filePath);
    if (local) hooks.setEditorContent(local.content);
    collab.lastLocalEditTs = 0;
  }
  hooks.updatePathUI(result.filePath);
  window.api.watcher.watchSource(result.filePath);
  hooks.runCompile();
  updateChip();
  closeCollabModal();
}

function pathDirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : p;
}

export async function startHost() {
  const app = hooks.getAppState();
  if (!app.currentFilePath) { setMsg('请先打开一个 .tex 文件再创建房间', true); return; }
  saveName();
  setMsg('正在创建房间…');
  // Disk becomes the shared source of truth — flush the editor first.
  await window.api.file.save(hooks.getEditorContent(), app.currentFilePath);
  const res = await window.api.collab.startHost(app.currentFilePath, hooks.getEditorContent(), collab.userName);
  if (!res.ok) { setMsg(`创建失败：${res.error}`, true); return; }
  await enterRoom({ role: 'host', roomId: res.roomId, roomName: res.roomName, wsPort: res.wsPort, filePath: app.currentFilePath });
  setMsg(`房间已创建 ✓ 项目文件夹已共享，把「${collab.hostAddr}」告诉队友即可加入`);
}

export async function joinRoom(entry) {
  saveName();
  setMsg(`正在加入 ${entry.addr}:${entry.wsPort} …`);
  const res = await window.api.collab.join({ addr: entry.addr, wsPort: entry.wsPort, name: collab.userName });
  if (!res.ok) { setMsg(`加入失败：${res.error}`, true); return; }
  await enterRoom(res);
  setMsg(`已加入「${res.roomName}」（主持人：${res.hostName}）✓ 本地共享文件夹已就绪`);
}

export function leaveCollab(reason) {
  clearTimeout(collab.saveTimer);
  clearTimeout(collab.pendingRemoteTimer);
  flushCollabSave().catch(() => {});
  collab.active = false;
  collab.peers = [];
  collab.pendingRemoteTex = null;
  collab.pendingSince = 0;
  window.api.collab.leave();

  const app = hooks.getAppState();
  app.modified = false;
  hooks.updateModified();
  updateChip();
  renderPeers();
  setMsg(reason || '已退出协作（本机文件保留）');
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
  chip.title = `共享文件夹协作中（${collab.role === 'host' ? '主持人' : '成员'}）· 点击查看`;
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
  peers.forEach((p) => {
    const item = document.createElement('span');
    item.className = 'collab-peer';
    item.innerHTML = `<span class="collab-peer-dot"></span><span class="collab-peer-name"></span>`;
    item.querySelector('.collab-peer-dot').style.background = p.role === 'host' ? '#ffbc42' : '#30bced';
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
    `房间「${collab.roomName}」 · ${collab.role === 'host' ? '你是主持人，加入地址 ' + collab.hostAddr : '主持人 ' + (collab.hostName || '') + ' @ ' + collab.hostAddr}`;
  $('collab-path').textContent = collab.projectDir || '';
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
  $('btn-collab-open-dir').addEventListener('click', () => {
    if (collab.projectDir) window.api.app.openPath(collab.projectDir);
  });
  $('btn-collab-copy-path').addEventListener('click', async () => {
    if (!collab.projectDir) return;
    try {
      await navigator.clipboard.writeText(collab.projectDir);
      $('btn-collab-copy-path').textContent = '已复制 ✓';
      setTimeout(() => { $('btn-collab-copy-path').textContent = '复制路径'; }, 1500);
    } catch {}
  });
  $('btn-collab-manual').addEventListener('click', () => {
    const raw = ($('collab-manual').value || '').trim();
    const m = raw.match(/^(?:ws:\/\/)?\[?([0-9a-zA-Z.:_-]+?)\]?:(\d+)$/);
    if (!m) { setMsg('地址格式：IP:端口，例如 192.168.1.23:48712', true); return; }
    joinRoom({ addr: m[1], wsPort: parseInt(m[2], 10) });
  });
}
