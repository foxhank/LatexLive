const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  },

  file: {
    open: () => ipcRenderer.invoke('file:open'),
    openPath: (filePath) => ipcRenderer.invoke('file:open-path', filePath),
    save: (content, filePath) => ipcRenderer.invoke('file:save', content, filePath),
    saveAs: (content) => ipcRenderer.invoke('file:save-as', content),
    read: (filePath) => ipcRenderer.invoke('file:read', filePath),
    readPdf: (filePath) => ipcRenderer.invoke('file:read-pdf', filePath),
    selectExecutable: () => ipcRenderer.invoke('file:select-executable'),
  },

  compiler: {
    detect: () => ipcRenderer.invoke('compiler:detect'),
    run: (filePath) => ipcRenderer.invoke('compile:run', filePath),
    preview: (filePath, content) => ipcRenderer.invoke('compile:preview', filePath, content),
    export: (filePath, content) => ipcRenderer.invoke('compile:export', filePath, content),
    getPdfPath: (filePath) => ipcRenderer.invoke('compile:get-pdf-path', filePath),
    getLog: (filePath) => ipcRenderer.invoke('compile:get-log', filePath),
  },

  synctex: {
    forward: (line, col, texPath) => ipcRenderer.invoke('synctex:forward', line, col, texPath),
    backward: (page, x, y, texPath) => ipcRenderer.invoke('synctex:backward', page, x, y, texPath),
  },

  watcher: {
    watchPdf: (pdfPath) => ipcRenderer.invoke('watcher:watch-pdf', pdfPath),
    unwatch: () => ipcRenderer.invoke('watcher:unwatch'),
    watchSource: (filePath) => ipcRenderer.invoke('watcher:watch-source', filePath),
    unwatchSource: () => ipcRenderer.invoke('watcher:unwatch-source'),
  },

  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
    getPath: (name) => ipcRenderer.invoke('app:get-path', name),
  },

  on: (channel, callback) => {
    const validChannels = ['pdf:updated', 'compile:progress', 'app:before-quit', 'source:changed'];
    if (validChannels.includes(channel)) {
      const sub = (_event, ...args) => callback(...args);
      ipcRenderer.on(channel, sub);
      return () => ipcRenderer.removeListener(channel, sub);
    }
  },
});
