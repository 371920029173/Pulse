const { app, BrowserWindow, shell, Tray, Menu, globalShortcut, nativeImage, nativeTheme, dialog, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');

const IS_PACKAGED = app.isPackaged;
/** Monorepo root in dev; unused for module resolution when packaged. */
const ROOT = IS_PACKAGED ? path.dirname(process.execPath) : path.resolve(__dirname, '../..');
try { app.setName('bot'); } catch { /* ignore */ }
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.she.bot'); } catch { /* ignore */ }
}

const UI_DEV_URL = process.env.SHE_UI_URL || 'http://127.0.0.1:5578';
const API_ORIGIN = process.env.SHE_API_ORIGIN || 'http://127.0.0.1:5577';
const API_HEALTH = `${API_ORIGIN}/api/health`;
/** When '0', the desktop will not spawn anything — it only attaches. */
const START_OWN = IS_PACKAGED ? true : process.env.SHE_ELECTRON_SPAWN !== '0';
/** pnpm is a .cmd shim on Windows; naming it explicitly avoids PATH surprises. */
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
function dataRoot() {
  try { return app.getPath('userData'); } catch { return path.join(ROOT, '.she-userdata'); }
}
const LOG_DIR = IS_PACKAGED ? path.join(dataRoot(), 'logs') : path.join(path.resolve(__dirname, '../..'), '.she');

/** @type {{child: import('node:child_process').ChildProcess, name: string}[]} */
const children = [];
/** @type {BrowserWindow | null} Most recently focused window. */
let mainWindow = null;
/**
 * Every open window.
 *
 * Was a single window, so "open another one" was impossible and each new
 * createWindow() call silently orphaned the previous one. Each window is a
 * separate renderer with its own sessionStorage, so they get independent
 * conversations for free.
 * @type {Set<BrowserWindow>}
 */
const windows = new Set();
/**
 * The app URL once the backend is reachable.
 *
 * Windows created before the backend is ready load the status page and are
 * pointed at the real URL when it resolves. Without this, only the FIRST window
 * was ever navigated — every later window (menu / Ctrl+Shift+N / sidebar
 * button) stayed on the loading spinner forever.
 * @type {string | null}
 */
let appUrl = null;
/** @type {Tray | null} */
let tray = null;
let isQuitting = false;

// ─── logging ────────────────────────────────────────────────────────────────

function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

/** Append a line to .she/desktop.log so launch failures are diagnosable. */
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try {
    ensureLogDir();
    const file = path.join(LOG_DIR, 'desktop.log');
    capLog(file);
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch { /* ignore */ }
}

/**
 * Cap a log file, keeping the newest part.
 *
 * These logs grow for the lifetime of an install and nothing rotated them, so a desktop app
 * that is opened daily accumulates forever — the shape of bug that surfaces much later as
 * "why is my disk filling up" rather than as an error. `launcher-server.log` had reached 7 MB
 * on the machine this was found on.
 *
 * Truncated from the FRONT, because the recent lines are what explain a failure. The cut
 * advances to the next newline so a multi-byte character is never split, which would leave a
 * replacement glyph at the top and make the first line look corrupt.
 */
function capLog(file, maxBytes = 2 * 1024 * 1024) {
  try {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size <= maxBytes) return;

    // Read only the tail so capping a large file stays cheap.
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    fs.closeSync(fd);

    const text = buf.toString('utf8');
    const brk = text.indexOf('\n');
    const body = brk === -1 ? text : text.slice(brk + 1);
    fs.writeFileSync(file, `…（日志过大已截断，仅保留最近 ${Math.round(maxBytes / 1024)}KB）\n${body}`, 'utf8');
  } catch {
    // Never let log housekeeping stop the app from starting.
  }
}

// ─── process helpers ────────────────────────────────────────────────────────

/**
 * Spawn a long-lived helper process, capturing its output to log files.
 * Previously stdio was 'ignore', so a failed spawn was completely invisible.
 */
function spawnProc(command, args, name, opts = {}) {
  ensureLogDir();
  let out = 'ignore';
  let err = 'ignore';
  try {
    const outFile = path.join(LOG_DIR, `desktop-${name}.log`);
    const errFile = path.join(LOG_DIR, `desktop-${name}.err.log`);
    // Bound before opening: these are reopened on every launch, so without a cap they only
    // ever grow.
    capLog(outFile);
    capLog(errFile);
    out = fs.openSync(outFile, 'a');
    err = fs.openSync(errFile, 'a');
  } catch { /* fall back to ignore */ }

  log(`spawn ${name}: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: opts.cwd || ROOT,
    shell: opts.shell !== undefined ? opts.shell : true,
    windowsHide: true,
    // Tell the server a native folder picker exists, so the home screen can
    // offer a real browse button instead of a path textbox.
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', SHE_NATIVE_PICKER: '1', ...(opts.env || {}) },
    stdio: ['ignore', out, err],
  });
  child.on('error', (e) => log(`${name} spawn error: ${e.message}`));
  child.on('exit', (code, signal) => log(`${name} exited code=${code} signal=${signal}`));

  const entry = { child, name, command, args, restarts: 0, stopped: false };
  children.push(entry);
  return entry;
}

/**
 * Keep a helper process alive.
 *
 * The API server was observed dying on its own (exit code -1, empty stderr).
 * Because nothing restarted it, the UI kept running against a dead backend and
 * every feature looked broken. Supervise it so a crash self-heals instead of
 * silently taking the whole product down.
 */
function spawnSupervised(command, args, name, { isHealthy, cwd, env, shell }) {
  let stopping = false;

  const start = () => {
    const entry = spawnProc(command, args, name, { cwd, env, shell });
    entry.child.on('exit', async () => {
      if (stopping || isQuitting) return;
      // Give the process a moment to release its port before restarting.
      await new Promise((r) => setTimeout(r, 1200));
      if (stopping || isQuitting) return;
      if (await isHealthy()) {
        log(`${name} exited but something is still serving — not restarting`);
        return;
      }
      entry.restarts += 1;
      if (entry.restarts > 8) {
        log(`${name} giving up after ${entry.restarts} restarts`);
        return;
      }
      log(`${name} restarting (attempt ${entry.restarts})`);
      start();
    });
    return entry;
  };

  const first = start();
  return {
    get restarts() { return first.restarts; },
    stop() { stopping = true; },
  };
}

/** Kill a process tree; child.kill() alone orphans the node grandchild on Windows. */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch { /* ignore */ }
}

function stopChildren() {
  for (const entry of children) {
    if (entry.stop) entry.stop();
    const { child, name } = entry;
    if (child.exitCode == null && child.pid) {
      log(`stopping ${name} (pid ${child.pid})`);
      killTree(child.pid);
    }
  }
  children.length = 0;
}

// ─── readiness probes ───────────────────────────────────────────────────────

function waitHttp(url, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve(true);
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) reject(new Error(`timeout waiting for ${url}`));
      else setTimeout(tick, 400);
    };
    tick();
  });
}

/** Is something already bound to this port (even if it is not healthy)? */
function portInUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
    sock.setTimeout(1200, () => done(false));
  });
}

// ─── backend bring-up ───────────────────────────────────────────────────────

/**
 * Ensure an API origin and a UI origin are reachable, spawning what is missing.
 *
 * Returns `{ url, problems }` — the caller decides what to do about failures
 * instead of silently loading a dead page.
 *
 * Note: the API server also serves the built UI from packages/ui/dist, so a
 * single process is enough. We prefer the Vite dev server when it is already
 * running (hot reload) and otherwise fall back to the API origin, which removes
 * the "UI is up but API is down" failure mode entirely.
 */
async function ensureBackend() {
  const problems = [];

  // 1. API (required)
  let apiUp = false;
  try {
    await waitHttp(API_HEALTH, 1500);
    apiUp = true;
    log('API already up');
  } catch {
    if (!START_OWN) {
      problems.push('API 未运行（SHE_ELECTRON_SPAWN=0，已禁用自动启动）');
    } else if (await portInUse(5577)) {
      problems.push('端口 5577 已被占用，但 /api/health 无响应 — 可能是上次残留进程');
    } else if (IS_PACKAGED) {
      log('starting packaged API…');
      const runtime = path.join(process.resourcesPath, 'runtime');
      const nodeBin = path.join(runtime, 'node.exe');
      const serverDir = path.join(runtime, 'server');
      const entry = path.join(serverDir, 'dist', 'index.js');
      const uiDir = path.join(runtime, 'ui');
      const ud = dataRoot();
      const workspace = process.env.SHE_WORKSPACE || path.join(ud, 'workspace');
      try { fs.mkdirSync(workspace, { recursive: true }); } catch { /* ignore */ }
      try { fs.mkdirSync(path.join(workspace, '.she', 'skills'), { recursive: true }); } catch { /* ignore */ }
      // Seed bundled skills once (do not overwrite user edits).
      const bundledSkills = path.join(runtime, 'skills');
      if (fs.existsSync(bundledSkills)) {
        const destSkills = path.join(workspace, '.she', 'skills');
        for (const name of fs.readdirSync(bundledSkills)) {
          const from = path.join(bundledSkills, name);
          const to = path.join(destSkills, name);
          if (!fs.existsSync(to)) {
            try {
              fs.cpSync(from, to, { recursive: true });
            } catch (e) {
              log('seed skill failed', name, e.message);
            }
          }
        }
      }
      if (!fs.existsSync(nodeBin) || !fs.existsSync(entry)) {
        problems.push('安装包缺少 runtime（node.exe 或 server），请重装 bot');
      } else {
        spawnSupervised(nodeBin, [entry], 'server', {
          cwd: serverDir,
          shell: false,
          env: {
            SHE_UI_DIR: uiDir,
            SHE_PORT: process.env.SHE_PORT || '5577',
            SHE_HOST: '127.0.0.1',
            SHE_WORKSPACE: workspace,
            // Do not invent a global SHE_KB_PATH. An unset path stores the
            // knowledge base in this workspace's .she/kb.sqlite. A global file
            // made every project look empty and mixed their notes together.
            ...(process.env.SHE_KB_PATH ? { SHE_KB_PATH: process.env.SHE_KB_PATH } : {}),
            SHE_NATIVE_PICKER: '1',
          },
          isHealthy: async () => {
            try { await waitHttp(API_HEALTH, 1200); return true; } catch { return false; }
          },
        });
      }
    } else {
      log('starting API…');
      spawnSupervised(PNPM, ['--filter', '@she/server', 'dev'], 'server', {
        isHealthy: async () => {
          try { await waitHttp(API_HEALTH, 1200); return true; } catch { return false; }
        },
      });
    }
    if (!problems.length) {
      try {
        await waitHttp(API_HEALTH, 120000);
        apiUp = true;
        log('API up');
      } catch {
        problems.push('API 启动超时（见 logs/desktop-server.*.log 或 .she/desktop-server.*.log）');
      }
    }
  }

  if (!apiUp) {
    return { url: null, problems };
  }

  // 2. UI: prefer the Vite dev server (dev only), else API static build.
  if (!IS_PACKAGED) {
  try {
    await waitHttp(UI_DEV_URL, 1200);
    log('UI dev server already up');
    return { url: UI_DEV_URL, problems };
  } catch { /* fall through */ }

  if (START_OWN && !(await portInUse(5578))) {
    log('starting UI dev server…');
    spawnSupervised(PNPM, ['--filter', '@she/ui', 'dev'], 'ui', {
      isHealthy: async () => {
        try { await waitHttp(UI_DEV_URL, 1200); return true; } catch { return false; }
      },
    });
    try {
      await waitHttp(UI_DEV_URL, 120000);
      log('UI up');
      return { url: UI_DEV_URL, problems };
    } catch {
      problems.push('UI 开发服务器启动超时，改用服务端内置界面');
    }
  }

  } // end !IS_PACKAGED vite path
  // The API origin serves packages/ui/dist — works without the dev server.
  log(IS_PACKAGED ? 'packaged: using API origin UI' : 'falling back to API origin (built UI)');
  return { url: API_ORIGIN, problems };
}

// ─── window ─────────────────────────────────────────────────────────────────

function statusPage(title, body) {
  const html = `<!doctype html><meta charset="utf-8">
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e6edf3;
       font:14px/1.65 system-ui,"Segoe UI",sans-serif}
  .card{max-width:660px;padding:28px 32px;border:1px solid rgba(130,150,190,.22);border-radius:14px;
        background:#11151e}
  h1{margin:0 0 10px;font-size:17px}
  ul{margin:10px 0 14px;padding-left:20px}
  li{margin:4px 0;color:#ffb4a2}
  code{background:#171c28;padding:2px 6px;border-radius:6px;font-size:12.5px}
  .hint{color:#8b949e;font-size:13px}
  .spin{width:14px;height:14px;border:2px solid #7c9cff;border-top-color:transparent;border-radius:50%;
        display:inline-block;animation:s .8s linear infinite;vertical-align:-2px;margin-right:8px}
  @keyframes s{to{transform:rotate(360deg)}}
</style>
<div class="card"><h1>${title}</h1>${body}</div>`;

  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function loadingPage() {
  return statusPage(
    '<span class="spin"></span>SHE 正在启动…',
    `<p class="hint">正在拉起后端服务（首次启动约需数秒）。</p>
     <p class="hint">日志：<code>.she/desktop.log</code></p>`,
  );
}

function errorPage(problems) {
  return statusPage(
    'SHE 启动失败',
    `<p class="hint">后端没有起来，所以界面无法工作。原因：</p>
     <ul>${problems.map((p) => `<li>${p}</li>`).join('')}</ul>
     <p class="hint">排查：查看 <code>.she/desktop.log</code> 与
     <code>.she/desktop-server.err.log</code>；<br>
     或手动运行 <code>start.cmd</code> 后重开桌面版。</p>`,
  );
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: 'bot',
    backgroundColor: '#111318',
    show: false,
    autoHideMenuBar: true,
    icon: fs.existsSync(path.join(__dirname, 'assets', 'icon.png'))
      ? path.join(__dirname, 'assets', 'icon.png')
      : undefined,
    // Native OS chrome (black title bar + min/max/close). Frameless was reverted per product ask.
    frame: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Renderer runs in the OS sandbox. The preload only uses contextBridge +
      // ipcRenderer, both of which are available under sandbox: true, so there
      // is no reason to weaken isolation here.
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  // Show a real status page immediately so a slow/failed boot is never a blank
  // window; if the backend is already up, go straight to the app.
  win.loadURL(appUrl ?? loadingPage());
  win.once('ready-to-show', () => win.show());

  windows.add(win);
  win.on('focus', () => { mainWindow = win; });
  win.on('closed', () => {
    windows.delete(win);
    if (mainWindow === win) mainWindow = [...windows][windows.size - 1] ?? null;
  });

  /**
   * Closing hides to the tray, but asks first if the agent is mid-task.
   *
   * The renderer publishes `window.__sheBusy`, so main can decide without an
   * IPC round-trip. Hiding while a turn is running would look like the work was
   * cancelled, so the user gets a real choice.
   */
  win.on('close', async (e) => {
    if (isQuitting) return;
    e.preventDefault();

    let busy = false;
    try {
      busy = await win.webContents.executeJavaScript('window.__sheBusy === true');
    } catch { /* renderer gone: treat as idle */ }

    if (!busy) {
      win.hide();
      return;
    }

    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['继续运行（取消）', '转到后台继续', '停止并退出'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      message: '智能体还在执行任务',
      detail:
        '任务不会因为关窗口而中断。\n\n' +
        '· 继续运行：什么都不做，回到界面\n' +
        '· 转到后台继续：隐藏窗口，任务照常跑完（可从托盘恢复）\n' +
        '· 停止并退出：终止一切，正在执行的任务会丢失',
    });

    if (response === 0) return;
    if (response === 1) { win.hide(); return; }
    isQuitting = true;
    app.quit();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow = win;
  return win;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    // Prefer an existing window before creating another.
    const alive = [...windows].filter((w) => !w.isDestroyed());
    if (alive.length) { mainWindow = alive[alive.length - 1]; }
    else { createWindow(); return; }
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Open an additional independent window (own session, same backend). */
function openNewWindow() {
  const win = createWindow();
  // Offset slightly so a second window does not land exactly on the first.
  try {
    const [x, y] = win.getPosition();
    win.setPosition(x + 28, y + 28);
  } catch { /* ignore */ }
  return win;
}

function createTray() {
  const trayIconFile = path.join(__dirname, 'assets', 'icon-32.png');
  const fromFile = fs.existsSync(trayIconFile) ? nativeImage.createFromPath(trayIconFile) : nativeImage.createEmpty();
  const img = fromFile.isEmpty() ? nativeImage.createEmpty() : fromFile;
  tray = new Tray(
    img.isEmpty()
      ? nativeImage.createFromDataURL(
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFUlEQVQ4T2NkYGD4z0AEYBxVSF+FAP7uAv6j3o2ZAAAAAElFTkSuQmCC',
        )
      : img,
  );
  tray.setToolTip('bot');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show bot', click: () => showMainWindow() },
      { label: 'New Window', click: () => openNewWindow() },
      { label: 'Hide', click: () => mainWindow && mainWindow.hide() },
      { type: 'separator' },
      { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]),
  );
  tray.on('double-click', () => showMainWindow());
}

// ─── lifecycle ──────────────────────────────────────────────────────────────

// ─── native dialogs ─────────────────────────────────────────────────────────
//
// Lets the renderer offer a real folder/file picker, the way Cursor does,
// instead of making the user type absolute paths.

/**
 * The window the user is interacting with.
 *
 * Module-level because both the IPC handlers and the application menu need it,
 * and with several windows open "mainWindow" alone is not enough.
 */
function focused() {
  const w = BrowserWindow.getFocusedWindow();
  if (w && !w.isDestroyed()) return w;
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const alive = [...windows].filter((x) => !x.isDestroyed());
  return alive[alive.length - 1];
}

function registerIpc() {
  ipcMain.handle('she:pickFolder', async () => {
    const win = focused();
    const r = await dialog.showOpenDialog(win, {
      title: '选择工作区',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('she:pickFile', async (_e, filters) => {
    const win = focused();
    const r = await dialog.showOpenDialog(win, {
      title: '选择文件',
      properties: ['openFile', 'multiSelections'],
      filters: Array.isArray(filters) && filters.length
        ? filters
        : [{ name: '知识文件', extensions: ['md', 'txt', 'json', 'jsonl', 'csv', 'yaml', 'yml'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    return r.filePaths;
  });

  /** Open another window; lets the renderer offer it from the UI. */
  ipcMain.handle('she:newWindow', () => { openNewWindow(); });

  ipcMain.handle('she:minimize', () => {
    const w = focused();
    if (w) w.minimize();
  });
  ipcMain.handle('she:maximize', () => {
    const w = focused();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle('she:close', () => {
    const w = focused();
    if (w) w.close();
  });
}

app.whenReady().then(async () => {
  log('desktop starting');

  // Force a dark native theme so the OS-drawn title bar and its buttons match
  // the app instead of showing a light strip above the content.
  try { nativeTheme.themeSource = 'dark'; } catch { /* older Electron */ }

  registerIpc();

  /**
   * Application menu.
   *
   * Kept hidden by default (autoHideMenuBar) so the window stays clean, but a
   * real File menu now exists: 「新建窗口」is the discoverable path to a second
   * window, alongside Ctrl+Shift+N and the tray item.
   */
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '文件',
        submenu: [
          { label: '新建窗口', accelerator: 'CommandOrControl+Shift+N', click: () => openNewWindow() },
          { label: '新建会话', accelerator: 'CommandOrControl+N', click: () => focused()?.webContents.send('she:newSession') },
          { type: 'separator' },
          { label: '显示主窗口', accelerator: 'CommandOrControl+Shift+S', click: () => showMainWindow() },
          { label: '退出', click: () => { isQuitting = true; app.quit(); } },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
          { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        ],
      },
      {
        label: '视图',
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { label: '新建窗口', click: () => openNewWindow() },
          { label: '最小化', role: 'minimize' },
          { label: '关闭窗口', role: 'close' },
        ],
      },
    ]),
  );

  const win = createWindow();
  createTray();
  globalShortcut.register('CommandOrControl+Shift+S', () => showMainWindow());
  globalShortcut.register('CommandOrControl+Shift+N', () => openNewWindow());

  let url = null;
  let problems = [];
  try {
    ({ url, problems } = await ensureBackend());
  } catch (err) {
    problems = [`未预期的启动错误：${err && err.message ? err.message : String(err)}`];
  }

  if (!url) {
    log('startup failed:', problems.join(' | '));
    await win.loadURL(errorPage(problems));
    return;
  }

  if (problems.length) log('warnings:', problems.join(' | '));
  log(`loading ${url}`);
  appUrl = url;
  // Point every open window at the app, not just the first one.
  for (const w of windows) {
    if (!w.isDestroyed()) w.loadURL(url).catch(() => { /* closed mid-navigation */ });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopChildren();
});

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  // Tray app: stay alive on Windows/Linux unless the user is quitting.
  if (process.platform === 'darwin') return;
  if (isQuitting) stopChildren();
});
