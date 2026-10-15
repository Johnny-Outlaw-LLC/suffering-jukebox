'use strict';
// The bridge the page sees as window.sjDesktop. public/index.html checks for
// it (sjIsDesktop) and never pretends to be the Capacitor shell: that would
// switch on the phone apps' native audio paths, which do not exist here.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sjDesktop', {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('desktop:getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('desktop:setSettings', patch),
  setMini: (open) => ipcRenderer.invoke('desktop:mini', !!open),
  pushState: (state) => ipcRenderer.send('desktop:state', state),
  signIn: (opts) => ipcRenderer.invoke('desktop:signIn', { url: String(opts?.url || '') }),
  onSettings: (cb) => { ipcRenderer.on('desktop:settings', (_e, s) => cb(s)); },
  onMini: (cb) => { ipcRenderer.on('desktop:mini', (_e, open) => cb(!!open)); },
  onCommand: (cb) => { ipcRenderer.on('desktop:command', (_e, cmd, arg) => cb(cmd, arg)); },
});
