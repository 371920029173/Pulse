/**
 * Cross-platform launcher.
 *
 * Why Node rather than a shell script per platform: the previous launcher was
 * PowerShell, so Windows had one and macOS/Linux had none. Maintaining a second
 * ~280-line bash copy would duplicate the logic and let the two drift. Node runs
 * wherever the project already requires, and it sidesteps the encoding problems
 * that made the .bat/.ps1 pair fragile (PowerShell 5.1 reads a .ps1 as ANSI
 * without a BOM, so one stray non-ASCII character broke the script's *syntax*).
 *
 * The thin wrappers (`SHE.bat`, `she.sh`) exist only so it can be double-clicked;
 * all logic lives here.
 *
 *   node scripts/she.mjs <launch|stop|restart|status> [--browser]
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, openSync, readSync, closeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  resolvePreferredPort, pidListeningOn,
} from './safe-port.mjs';

const require = createRequire(import.meta.url);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, '..');

let API_PORT = Number(process.env.SHE_PORT || 5577);
let HEALTH_URL = `http://127.0.0.1:${API_PORT}/api/health`;

const STATE_DIR = join(ROOT, '.she');
const PID_FILE = join(STATE_DIR, 'server.pid');
/*
 * Two logs, two purposes, and they used to be one file.
 *
 * The captured stderr stream went to `.she/crash.log` — the SAME path the server appends real
 * crash dumps to (see `installCrashHandlers` in `packages/server/src/index.ts`). So
 * `crash.log` filled with routine warnings ("Refused request: …", "session not found") and no
 * longer meant "something crashed": 62 lines, 60 of them warnings, zero crash headers in the
 * copy on this machine. A user opening it would reasonably conclude the app crashes constantly,
 * and the one time it DOES crash the report is buried in noise.
 *
 * stderr now goes to its own file. `crash.log` is written only by the server's crash handler.
 */
const LOG_FILE = join(STATE_DIR, 'launcher-server.log');
const ERR_FILE = join(STATE_DIR, 'server-err.log');

/**
 * Cap a log file, keeping the newest part.
 *
 * Both of these grow forever otherwise: `launcher-server.log` had reached 7 MB on this machine
 * with nothing rotating it, which is the kind of slow growth that shows up much later as "why
 * is my disk filling up".
 *
 * Truncated from the FRONT, because the recent lines are the ones that explain a failure. The
 * cut is advanced to the next newline so a multi-byte UTF-8 character is never split in half —
 * which would put a replacement glyph at the top of the file and make the first line look
 * corrupt.
 */
function capLog(file, maxBytes = 2 * 1024 * 1024) {
  try {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size <= maxBytes) return;

    // Read only the tail, rather than the whole file, so capping a large log stays cheap.
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, size - maxBytes);
    closeSync(fd);

    const text = buf.toString('utf8');
    const firstBreak = text.indexOf('\n');
    const body = firstBreak === -1 ? text : text.slice(firstBreak + 1);
    writeFileSync(file, `…（日志过大已截断，仅保留最近 ${Math.round(maxBytes / 1024)}KB）\n${body}`, 'utf8');
  } catch {
    // Never let log housekeeping stop the app from starting.
  }
}

const IS_WINDOWS = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

function applyPort(p) {
  API_PORT = p;
  HEALTH_URL = `http://127.0.0.1:${API_PORT}/api/health`;
}

function resolveApiPort() {
  try {
    return resolvePreferredPort(process.env.SHE_PORT, 5577);
  } catch (e) {
    err(String(e.message || e));
    process.exit(1);
  }
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const head = (t) => console.log(paint('36', t));
const ok = (t) => console.log(`      ${paint('32', t)}`);
const info = (t) => console.log(`      ${paint('90', t)}`);
const warn = (t) => console.log(`      ${paint('33', t)}`);
const err = (t) => console.log(paint('31', t));

// ─── Messages ───
// Localized text lives in JSON so this file stays ASCII-safe, for the same
// reason the PowerShell version kept it out of the script.
const M = { /* defaults assigned below */ };
Object.assign(M, {
  title: 'Pulse',
  statusTitle: 'Pulse status',
  serverRunning: 'Backend running',
  serverStopped: 'Backend not running',
  windowRunning: 'Desktop window running',
  windowStopped: 'Desktop window not running',
  processes: 'processes',
  stopping: '[stop] Closing Pulse',
  stoppedBackend: 'Backend stopped',
  backendNotRunning: 'Backend not running (port free)',
  stoppedWindows: 'Desktop window closed',
  notProjectDir: '[ERROR] Not a Pulse project directory',
  notProjectHint: 'Put this script in the project scripts/ folder.',
  needNode: '[ERROR] Node.js not found. Install Node 20+: https://nodejs.org',
  needPnpm: '[ERROR] pnpm not found. Run: npm install -g pnpm',
  checkDeps: '[1/4] Checking dependencies',
  firstRunInstall: 'First run: installing dependencies (may take a few minutes)...',
  installFailed: '[ERROR] pnpm install failed.',
  ready: 'ready',
  buildStep: '[2/4] Build (only when needed)',
  sourceChanged: 'Source changes detected',
  building: 'Building...',
  buildFailed: '[ERROR] Build failed.',
  startBackend: '[3/4] Starting backend',
  portAlready: 'Port already listening, skipping start',
  startingWait: 'Started, waiting for readiness...',
  healthStep: '[4/4] Waiting for the service',
  healthTimeout: '[ERROR] Service was not ready within 48 seconds.',
  logLabel: 'log',
  errLabel: 'errors',
  logTail: 'Last log lines:',
  serviceLabel: 'Service',
  stopHint: 'Stop: run ./she.sh stop   (Windows: SHE-stop.bat)',
  openingWindow: 'Opening the desktop window...',
  windowFailed: 'Desktop window did not start, using the browser.',
  noElectron: 'Electron not found (run pnpm install), using the browser.',
  keepRunning: 'The service keeps running in the background; you can close this window.',
});
try {
  // Strip a UTF-8 BOM before parsing. Editors and PowerShell's `Set-Content
  // -Encoding UTF8` add one, and `JSON.parse` rejects it — which silently
  // downgraded every message to English until this was handled.
  const raw = readFileSync(join(SCRIPT_DIR, 'launcher-messages.json'), 'utf8').replace(/^\uFEFF/, '');
  Object.assign(M, JSON.parse(raw));
} catch {
  // English defaults are fine.
}

// ─── Helpers ───

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is `cmd` runnable?
 *
 * Checks for ENOENT rather than the exit code, because the commands we probe
 * (`node --version`, `pnpm --version`) are expected to succeed, while a missing
 * one fails to spawn at all.
 */
function has(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', shell: IS_WINDOWS, windowsHide: true });
  return !(r.error && r.error.code === 'ENOENT');
}

/** Is the backend answering on its health endpoint? */
async function serverUp() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2000);
    const r = await fetch(HEALTH_URL, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * The running server's PID, from our own pidfile.
 *
 * Deliberately not OS port-query tools: those differ per
 * platform and their output differs per locale, which is how "stop" ends up
 * working on one machine and silently doing nothing on another. We started the
 * process, so we write its PID down.
 */
function readPid() {
  let pid;
  try {
    pid = Number(readFileSync(PID_FILE, 'utf8').trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // liveness probe; throws when the process is gone
    return pid;
  } catch {
    return null;
  }
}

function writePid(pid) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(pid), 'utf8');
}

/** Kill a process and its children, portably. */
function killTree(pid) {
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  // The server is spawned detached, so it leads its own process group. Killing
  // the group takes MCP child processes with it; killing the PID alone would
  // leave them holding the port.
  try { process.kill(-pid, 'SIGTERM'); } catch { /* group already gone */ }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
}

/** How many Electron processes are running, for `status`. */
function electronCount() {
  try {
    if (IS_WINDOWS) {
      const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/NH'], {
        encoding: 'utf8', windowsHide: true,
      }).stdout ?? '';
      return (out.match(/electron\.exe/gi) ?? []).length;
    }
    const out = spawnSync('pgrep', ['-c', '-f', 'electron'], { encoding: 'utf8' }).stdout ?? '';
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

/** Open a URL in the user's browser. */
function openBrowser(url) {
  const [cmd, args] = IS_WINDOWS
    ? ['cmd', ['/c', 'start', '', url]]
    : IS_MAC
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    info(`请手动打开 ${url}`);
  }
}

/** Path to the Electron binary, or null when it is not installed. */
function electronBinary() {
  const bin = IS_WINDOWS
    ? 'electron.exe'
    : IS_MAC
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';
  for (const dist of [
    join(ROOT, 'node_modules', 'electron', 'dist'),
    join(ROOT, 'packages', 'desktop', 'node_modules', 'electron', 'dist'),
  ]) {
    const local = join(dist, bin);
    if (existsSync(local)) return local;
  }
  try {
    const p = require('electron');
    return typeof p === 'string' && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Newest mtime under a directory, or 0. */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try {
        const m = statSync(p).mtimeMs;
        if (m > newest) newest = m;
      } catch { /* unreadable entry; skip */ }
    }
  };
  walk(dir);
  return newest;
}

/** Why a build is needed, or null when the artifacts are current. */
function buildReason() {
  const serverDist = join(ROOT, 'packages', 'server', 'dist', 'index.js');
  const uiDist = join(ROOT, 'packages', 'ui', 'dist', 'index.html');
  if (!existsSync(serverDist) || !existsSync(uiDist)) return 'artifacts missing';
  const built = statSync(serverDist).mtimeMs;
  const newest = Math.max(
    newestMtime(join(ROOT, 'packages', 'server', 'src')),
    newestMtime(join(ROOT, 'packages', 'ui', 'src')),
    newestMtime(join(ROOT, 'packages', 'agent-runtime', 'src')),
    newestMtime(join(ROOT, 'packages', 'kb', 'src')),
    newestMtime(join(ROOT, 'packages', 'sandbox', 'src')),
    newestMtime(join(ROOT, 'packages', 'shared', 'src')),
  );
  return newest > built ? 'source changed' : null;
}

// ─── Actions ───

async function showStatus() {
  console.log('');
  head(M.statusTitle);
  const up = await serverUp();
  const pid = readPid();
  if (up) ok(`${M.serverRunning}${pid ? ` (PID ${pid})` : ''}  ${HEALTH_URL}`);
  else warn(M.serverStopped);
  const n = electronCount();
  if (n > 0) ok(`${M.windowRunning} (${n} ${M.processes})`);
  else info(M.windowStopped);
  console.log('');
}

function stopAll() {
  head(M.stopping);
  const pid = readPid();
  if (pid) {
    killTree(pid);
    rmSync(PID_FILE, { force: true });
    ok(`${M.stoppedBackend} (PID ${pid})`);
  } else {
    info(`${M.backendNotRunning} ${API_PORT}`);
  }
  // Orphan: pidfile gone but something still listens — common after a crash or manual kill -9 of the launcher tree.
  const orphan = pidListeningOn(API_PORT);
  if (orphan && orphan !== pid) {
    warn(`Port ${API_PORT} still held by PID ${orphan}; forcing stop.`);
    killTree(orphan);
    rmSync(PID_FILE, { force: true });
    ok(`${M.stoppedBackend} (orphan PID ${orphan})`);
  }

  if (IS_WINDOWS) {
    const n = electronCount();
    if (n > 0) {
      spawnSync('taskkill', ['/IM', 'electron.exe', '/F'], { stdio: 'ignore', windowsHide: true });
      ok(`${M.stoppedWindows} (${n} ${M.processes})`);
    }
  } else {
    spawnSync('pkill', ['-f', 'electron'], { stdio: 'ignore' });
  }
}

async function launch(openInBrowser) {
  console.log('');
  head('============================================');
  head(`  ${M.title}`);
  head('============================================');
  console.log('');

  if (!existsSync(join(ROOT, 'package.json'))) {
    err(`${M.notProjectDir}: ${ROOT}`);
    err(`       ${M.notProjectHint}`);
    return 1;
  }
  if (!has('node')) { err(M.needNode); return 1; }
  if (!has('pnpm')) { err(M.needPnpm); return 1; }

  info(`Node  ${process.version}`);
  info(`Dir   ${ROOT}`);
  info(`OS    ${process.platform} ${process.arch}`);
  console.log('');

  head(M.checkDeps);
  if (!existsSync(join(ROOT, 'node_modules'))) {
    info(M.firstRunInstall);
    const r = spawnSync('pnpm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS });
    if (r.status !== 0) { err(M.installFailed); return 1; }
  }
  ok(M.ready);

  head(M.buildStep);
  const why = buildReason();
  if (why) {
    info(`${M.sourceChanged} (${why})`);
    info(M.building);
    const r = spawnSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit', shell: IS_WINDOWS });
    if (r.status !== 0) { err(M.buildFailed); return 1; }
  }
  ok(M.ready);

  head(M.startBackend);
  if (await serverUp()) {
    ok(`${M.portAlready} ${API_PORT}`);
  } else {
    mkdirSync(STATE_DIR, { recursive: true });
    /*
     * Hand the log files to the child as file descriptors instead of piping them
     * through this process. Piping looks equivalent but is not: when the launcher
     * exits, the pipes close and the next write from the server kills it. That is
     * exactly what happened — the service reported ready, then vanished the
     * moment the launcher returned.
     */
    // Bound both logs before opening them for append, so a long-running install cannot fill
    // the disk one warning at a time.
    capLog(LOG_FILE);
    capLog(ERR_FILE);
    const outFd = openSync(LOG_FILE, 'a');
    const errFd = openSync(ERR_FILE, 'a');
    const child = spawn(process.execPath, ['dist/index.js'], {
      cwd: join(ROOT, 'packages', 'server'),
      // Detached on every platform: the service must outlive the launcher, and
      // on POSIX this also gives it its own process group so the whole tree can
      // be killed later.
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
      env: { ...process.env, SHE_PORT: String(API_PORT) },
    });
    // The child holds its own copies; ours must not keep the files locked.
    closeSync(outFd);
    closeSync(errFd);

    if (child.pid) writePid(child.pid);
    child.unref();
    info(M.startingWait);
  }

  head(M.healthStep);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (await serverUp()) { ready = true; break; }
    await sleep(800);
  }

  if (!ready) {
    console.log('');
    err(M.healthTimeout);
    err(`       ${M.logLabel}: ${LOG_FILE}`);
    err(`       ${M.errLabel}: ${ERR_FILE}`);
    console.log('');
    if (existsSync(LOG_FILE)) {
      info(M.logTail);
      for (const l of readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-12)) {
        console.log(`      ${paint('90', l)}`);
      }
    }
    return 1;
  }
  ok(M.ready);

  console.log('');
  head('============================================');
  console.log(`  ${M.serviceLabel}:  http://127.0.0.1:${API_PORT}`);
  console.log(`  ${M.stopHint}`);
  head('============================================');
  console.log('');

  const electron = electronBinary();
  if (!openInBrowser && electron) {
    info(M.openingWindow);
    // The backend is already up, so the shell only attaches to it.
    spawn(electron, ['.'], {
      cwd: join(ROOT, 'packages', 'desktop'),
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SHE_ELECTRON_SPAWN: '0', SHE_PORT: String(API_PORT) },
    }).unref();
    await sleep(2500);
    if (electronCount() === 0) {
      info(M.windowFailed);
      openBrowser(`http://127.0.0.1:${API_PORT}`);
    }
  } else {
    if (!openInBrowser) info(M.noElectron);
    openBrowser(`http://127.0.0.1:${API_PORT}`);
  }

  console.log('');
  info(M.keepRunning);
  return 0;
}

// ─── Entry ───

const argv = process.argv.slice(2);
const action = argv.find((a) => !a.startsWith('-')) ?? 'launch';
const browser = argv.includes('--browser');

applyPort(resolveApiPort());

switch (action) {
  case 'status':
    await showStatus();
    process.exit(0);
    break;
  case 'stop':
    console.log('');
    stopAll();
    console.log('');
    process.exit(0);
    break;
  case 'restart':
    console.log('');
    stopAll();
    await sleep(2000);
    process.exit(await launch(browser));
    break;
  case 'launch':
    process.exit(await launch(browser));
    break;
  default:
    err(`未知动作: ${action}`);
    console.log('用法: node scripts/she.mjs <launch|stop|restart|status> [--browser]');
    process.exit(1);
}
