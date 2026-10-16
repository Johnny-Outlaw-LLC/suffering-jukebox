'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rkMini', {
  ready: () => ipcRenderer.send('mini:ready'),
  command: (cmd, arg) => ipcRenderer.send('mini:command', cmd, arg),
  expand: () => ipcRenderer.send('mini:expand'),
  menu: (at) => ipcRenderer.send('mini:menu', { x: Number(at?.x) || 0, y: Number(at?.y) || 0 }),
  onToast: (cb) => { ipcRenderer.on('mini:toast', (_e, t) => cb(String(t || ''))); },
  setPinned: (on) => ipcRenderer.invoke('desktop:setSettings', { alwaysOnTop: !!on }),
  onState: (cb) => { ipcRenderer.on('mini:state', (_e, s) => cb(s)); },
  onSettings: (cb) => { ipcRenderer.on('mini:settings', (_e, s) => cb(s)); },
});
