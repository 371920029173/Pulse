// Preload: exposes a tiny, explicit API to the renderer.
// contextIsolation stays on; nothing else from Node is reachable.
const { contextBridge, ipcRenderer } = require('electron');

/**
 * The access token, if the server was started with one.
 *
 * Read from `process.argv` rather than `process.env` because this preload runs sandboxed, where
 * `env` does not exist. Reading it here instead of through an IPC round-trip matters: the renderer
 * needs the token before its FIRST request, and an async fetch would leave a window in which the
 * app looks empty for reasons it cannot explain.
 *
 * Only the single-token form is passed down (see main.cjs); multi-tenant installs pick a tenant
 * deliberately rather than inheriting whichever one the desktop happened to see.
 */
const AUTH_ARG = '--she-auth-token=';
const authToken = (process.argv || []).find((a) => typeof a === 'string' && a.startsWith(AUTH_ARG))
  ?.slice(AUTH_ARG.length) || null;

contextBridge.exposeInMainWorld('sheDesktop', {
  /** True when running inside the Electron shell. */
  isDesktop: true,
  /** The token the local API expects; null when the server is not gated. */
  authToken,
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
