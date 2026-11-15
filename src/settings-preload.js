const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cfg', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (k, v) => ipcRenderer.send('settings:set', k, v),
  action: (a) => ipcRenderer.send('settings:action', a),
  onChange: (fn) => ipcRenderer.on('settings', (_e, p) => fn(p)),
});
