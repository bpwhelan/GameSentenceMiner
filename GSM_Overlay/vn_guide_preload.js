const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vnGuide', {
  onState: callback => ipcRenderer.on('vn-guide-state', (_event, state) => callback(state)),
  command: action => { if (['next', 'back', 'hide'].includes(action)) void ipcRenderer.invoke('vn-guide-command', { action }); },
});
