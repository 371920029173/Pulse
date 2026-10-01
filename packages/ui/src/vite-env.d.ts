/// <reference types="vite/client" />

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

/**
 * The desktop shell's bridge, injected by packages/desktop/preload.cjs.
 * Optional because the same UI also runs in a plain browser.
 */
interface SheDesktopBridge {
  isDesktop: boolean;
  pickFolder: () => Promise<string | null>;
  pickFile: (filters?: unknown) => Promise<string[] | null>;
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  /** Open another independent window. */
  newWindow: () => Promise<void>;
  /**
   * Move this window onto the backend for a workspace (one server per workspace).
   * Resolves to the new origin, or null when the shell cannot do it and the
   * caller must fall back to an in-page switch. Optional: older shells lack it.
   */
  openWorkspace?: (root: string) => Promise<string | null>;
  /** Subscribe to the File > 新建会话 menu item; returns an unsubscribe. */
  onNewSession?: (handler: () => void) => () => void;
  /**
   * Announce a settings write so the other windows' backends catch up.
   *
   * Pass the same body that went to `PUT /api/settings`; the shell replays it to the other backends
   * and strips workspace-scoped fields. Absent in a plain browser, where there is nothing to notify.
   */
  settingsChanged?: (body: Record<string, unknown>) => Promise<unknown>;
}

interface Window {
  sheDesktop?: SheDesktopBridge;
  /**
   * True while the agent is running a turn.
   *
   * Read by the main process before closing a window so it can ask before
   * hiding mid-task. A plain global avoids an IPC round-trip on the close path.
   */
  __sheBusy?: boolean;
}

