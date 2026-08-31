const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),

  // Dialogs & navigation
  selectDirectory: () => ipcRenderer.invoke('dialog:open-directory'),
  openPath: (targetPath) => ipcRenderer.invoke('shell:open-path', targetPath),

  // Download prompt window
  closePrompt: () => ipcRenderer.send('prompt:close'),
  onSetUrl: (callback) => ipcRenderer.on('prompt:set-url', (_event, value) => callback(value)),

  // Notifications (download complete / error toasts from renderer)
  showNotification: (title, body) => ipcRenderer.send('app:notify', { title, body }),

  // Server port for renderer-side API calls
  getServerPort: () => ipcRenderer.invoke('app:get-server-port')
});