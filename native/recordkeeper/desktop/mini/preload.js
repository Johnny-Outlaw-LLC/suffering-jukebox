'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rkMini', {
  ready: () => ipcRenderer.send('mini:ready'),
  command: (cmd, arg) => ipcRenderer.send('mini:command', cmd, arg),
  expand: () => ipcRenderer.send('mini:expand'),
  setPinned: (on) => ipcRenderer.invoke('desktop:setSettings', { alwaysOnTop: !!on }),
  onState: (cb) => { ipcRenderer.on('mini:state', (_e, s) => cb(s)); },
  onSettings: (cb) => { ipcRenderer.on('mini:settings', (_e, s) => cb(s)); },
});
