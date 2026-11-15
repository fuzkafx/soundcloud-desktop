const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sc', {
  send: (cmd, arg) => ipcRenderer.send('widget', cmd, arg),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onConfig: (fn) => ipcRenderer.on('config', (_e, c) => fn(c)),
});
