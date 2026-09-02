const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  onMaximizedStateChanged: (callback) => {
    const wrap = (_e, value) => callback(!!value);
    ipcRenderer.on('window:maximized-state', wrap);
    // Return a disposer so callers can clean up if needed
    return () => ipcRenderer.removeListener('window:maximized-state', wrap);
  },

  // Dialogs & navigation
  selectDirectory: () => ipcRenderer.invoke('dialog:open-directory'),
  openPath: (targetPath) => ipcRenderer.invoke('shell:open-path', targetPath),

  // Download prompt window
  closePrompt: () => ipcRenderer.send('prompt:close'),
  onSetUrl: (callback) => ipcRenderer.on('prompt:set-url', (_event, value) => callback(value)),

  // Notifications (download complete / error toasts from renderer)
  showNotification: (title, body) => ipcRenderer.send('app:notify', { title, body }),

  // Renderer-driven prompt invocation (currently used by the clipboard button)
  triggerPrompt: (url) => ipcRenderer.send('download:trigger-prompt', url),

  // Server port for renderer-side API calls
  getServerPort: () => ipcRenderer.invoke('app:get-server-port'),
  healthCheck: () => ipcRenderer.invoke('app:health-check'),
  reportFatal: (message) => ipcRenderer.send('app:report-fatal', { message })
});