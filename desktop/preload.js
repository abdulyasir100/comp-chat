'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/* window.ryzaShell — the web layer shows its frameless-window controls
   (minimize / close) only when this exists. */
contextBridge.exposeInMainWorld('ryzaShell', {
  platform: 'electron',
  minimize: () => ipcRenderer.send('shell:minimize'),
  close: () => ipcRenderer.send('shell:close'),
  setFullscreen: (on) => ipcRenderer.send('shell:fullscreen', !!on),
  quit: () => ipcRenderer.send('shell:quit'),
  saveWebStorage: (obj) => ipcRenderer.send('storage:save', obj),
  saveWebStorageSync: (obj) => ipcRenderer.sendSync('storage:save-sync', obj)
});
