// Preload: exposes a tiny, explicit API to the renderer.
// contextIsolation stays on; nothing else from Node is reachable.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sheDesktop', {
  /** True when running inside the Electron shell. */
  isDesktop: true,
  /** Native folder picker. Resolves to an absolute path, or null if cancelled. */
  pickFolder: () => ipcRenderer.invoke('she:pickFolder'),
  /** Native open-file dialog for choosing a knowledge file to import. */
  pickFile: (filters) => ipcRenderer.invoke('she:pickFile', filters),
  /** Window controls (kept for API compat; native frame owns the chrome now). */
  minimize: () => ipcRenderer.invoke('she:minimize'),
  maximize: () => ipcRenderer.invoke('she:maximize'),
  close: () => ipcRenderer.invoke('she:close'),
  /** Open another independent window (own conversation, same backend). */
  newWindow: () => ipcRenderer.invoke('she:newWindow'),
  /**
   * Fired by the File > 新建会话 menu item.
   * Returns an unsubscribe function so React effects can clean up.
   */
  onNewSession: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('she:newSession', listener);
    return () => ipcRenderer.removeListener('she:newSession', listener);
  },
});
