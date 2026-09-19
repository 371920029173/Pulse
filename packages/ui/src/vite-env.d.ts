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
  /** Subscribe to the File > 新建会话 menu item; returns an unsubscribe. */
  onNewSession?: (handler: () => void) => () => void;
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

