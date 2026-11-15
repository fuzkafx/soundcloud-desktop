const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menu', {
  onShow: (fn) => ipcRenderer.on('menu:show', (_e, payload) => fn(payload)),
  size: (w, h) => ipcRenderer.send('menu:size', w, h),
  pick: (id) => ipcRenderer.send('menu:pick', id),
  close: () => ipcRenderer.send('menu:close'),
});
