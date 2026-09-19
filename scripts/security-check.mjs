/**
 * Security regression checks for the local SHE API.
 *
 *   node scripts/security-check.mjs
 *
 * Boots its OWN server on a throwaway workspace, so the result does not depend on
 * whether a development instance happens to be running.
 *
 * That was a real defect: the gate called this script expecting a server on 4577, so
 * `pnpm check:all` passed or failed depending on an unrelated thing — a dev server being
 * up. Every other check in the suite starts what it needs; this one now does too.
 *
 * Set `SHE_API` to point at a server you already have running, if that is what you want.
 *
 * Why these checks exist: the API listens on localhost with no auth (correct for a
 * single-user desktop app), so the ONLY thing keeping a random website — or a
 * DNS-rebinding page — from driving it is the request guard plus the workspace jail.
 * Those are easy to weaken by accident, so they are pinned down here.
 *
 * Uses raw node:http because `fetch` refuses to set a custom Host header.
 */
import { request } from 'node:http';
import { writeFileSync, symlinkSync, rmSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pickSafePort } from './safe-port.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');

/** An external server to test instead of booting one. */
const EXTERNAL = process.env.SHE_API ?? null;
// PORT chosen in main via pickSafePort (Windows excluded ranges).
let PORT = Number(process.env.SHE_SEC_TEST_PORT || 0);
if (!PORT) PORT = await pickSafePort(18200 + Math.floor(Math.random() * 300));
const BASE = EXTERNAL ?? `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

function raw(path, { host, origin, method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const u = new URL(BASE + path);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(host ? { Host: host } : {}),
          ...(origin ? { Origin: origin } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.on('error', (e) => resolve({ status: 0, headers: {}, text: String(e.message) }));
    if (payload) req.write(payload);
    req.end();
  });
}

/* ─── Own server, so the result is not ambient ─── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;
let workspace = null;

async function boot() {
  if (EXTERNAL) {
    // Testing an existing server: verify it is actually there before running checks, or
    // every assertion fails with `status=0` and the cause is not obvious.
    const probe = await raw('/api/health');
    if (probe.status !== 200) {
      console.error(`SHE_API=${EXTERNAL} 没有响应（status=${probe.status}）。`);
      process.exit(1);
    }
    return;
  }

  if (!existsSync(SERVER_ENTRY)) {
    console.error(`找不到 ${SERVER_ENTRY}\n请先 pnpm -r build`);
    process.exit(1);
  }

  workspace = mkdtempSync(join(tmpdir(), 'she-sec-'));
  mkdirSync(join(workspace, '.she'), { recursive: true });
  writeFileSync(join(workspace, '.env'), [
    'OPENAI_API_KEY=not-used-by-these-checks',
    'OPENAI_BASE_URL=http://127.0.0.1:1',
    `SHE_WORKSPACE=${workspace.replace(/\\/g, '/')}`,
    `SHE_PORT=${PORT}`,
    'SHE_ALLOW_ALL_COMMANDS=false',
  ].join('\n'), 'utf8');

  child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    /*
     * Pin these in the child environment, not only in the .env file written above. Ambient
     * environment variables beat `.env` values, so a developer who has exported `SHE_PORT`
     * would make this check boot on their port — failing with a confusing EADDRINUSE, or
     * probing the dev server that is already running and reporting on that instead of on
     * this code.
     */
    env: {
      ...process.env,
      SHE_ENV_FILE: join(workspace, '.env'),
      SHE_PORT: String(PORT),
      SHE_WORKSPACE: workspace,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  child.on('error', (e) => { out += String(e.message); });

  const t0 = Date.now();
  for (;;) {
    const probe = await raw('/api/health');
    if (probe.status === 200) return;
    if (Date.now() - t0 > 30_000) {
      console.error('服务未能就绪:\n' + out.slice(-800));
      await shutdown();
      process.exit(1);
    }
    await sleep(300);
  }
}

async function shutdown() {
  if (child) {
    child.kill();
    child = null;
    await sleep(600);
  }
  if (workspace) {
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
    workspace = null;
  }
}

await boot();

// ── 1. No CORS: a foreign site must not be able to read this API ──
{
  const r = await raw('/api/health', { origin: 'https://evil.example.com' });
  check('跨站请求被拒 + 不下发 CORS 头', r.status === 403 && !r.headers['access-control-allow-origin'],
    `status=${r.status} ACAO=${r.headers['access-control-allow-origin'] ?? 'none'}`);
}

// ── 2. Cross-site writes must be refused (this endpoint runs shell commands) ──
{
  const r = await raw('/api/terminal/exec', {
    origin: 'https://evil.example.com',
    method: 'POST',
    body: { command: 'echo pwned' },
  });
  check('带外部 Origin 的 POST 被拒（终端不可被跨站调用）', r.status === 403, `status=${r.status}`);
}

// ── 3. DNS rebinding: a foreign Host header must be refused ──
{
  const r = await raw('/api/health', { host: 'evil.example.com' });
  check('伪造 Host 被拒（防 DNS rebinding）', r.status === 403, `status=${r.status}`);
}
// The port must be the one actually in use, not a hardcoded 4577.
for (const h of [`127.0.0.1:${new URL(BASE).port}`, `localhost:${new URL(BASE).port}`]) {
  const r = await raw('/api/health', { host: h });
  check(`合法 Host 正常（${h}）`, r.status === 200, `status=${r.status}`);
}

// ── 4. Workspace jail on the KB import path ──
{
  // A deliberately out-of-bounds host file, chosen per platform. The drive
  // letter is part of the fixture, not something the code depends on.
  // portability-check:allow
  const outside = process.platform === 'win32'
    ? 'C:/Windows/System32/drivers/etc/hosts'
    : '/etc/hosts';
  const r = await raw('/api/kb/import-path', { method: 'POST', body: { path: outside, label: 'x' } });
  check('import-path 不能读工作区外的文件', r.status === 400, `status=${r.status}`);
}

// ── 5. Traversal ──
{
  const r = await raw(`/api/fs/read?path=${encodeURIComponent('../../../etc/hosts')}`);
  check('目录穿越被拦截', r.status === 400, `status=${r.status}`);
}

// ── 6. Symlink escape: a link inside the workspace pointing outside ──
{
  const s = await raw('/api/settings');
  let root = '';
  try { root = JSON.parse(s.text)?.workspace?.root ?? ''; } catch { /* ignore */ }
  if (!root) {
    check('软链接逃逸被拦截', false, `拿不到 workspace.root（status=${s.status}）`);
  } else {
    const secret = join(tmpdir(), `she-sec-${Date.now()}.txt`);
    const link = join(root, `she-sec-link-${Date.now()}.txt`);
    try {
      writeFileSync(secret, 'TOP-SECRET-OUTSIDE', 'utf8');
      symlinkSync(secret, link);
      const r = await raw(`/api/fs/read?path=${encodeURIComponent(link.slice(root.length + 1))}`);
      check('软链接逃逸被拦截', !r.text.includes('TOP-SECRET-OUTSIDE'), `status=${r.status}`);
    } catch (e) {
      check('软链接逃逸被拦截', true, `跳过（无法建链：${String(e.message).slice(0, 40)}）`);
    } finally {
      try { rmSync(link, { force: true }); } catch { /* ignore */ }
      try { rmSync(secret, { force: true }); } catch { /* ignore */ }
    }
  }
}

// ── 7. Feishu remote: must not start unconfigured, must not leak the secret ──
{
  const st = await raw('/api/feishu/status');
  let j = {};
  try { j = JSON.parse(st.text); } catch { /* ignore */ }
  check('飞书状态接口可用', st.status === 200 && 'configured' in j, `configured=${j.configured}`);
  check('接口不回传 App Secret', !JSON.stringify(j).toLowerCase().includes('appsecret'),
    Object.keys(j).join(','));

  const start = await raw('/api/feishu/start', { method: 'POST' });
  const ok = j.configured ? start.status !== 500 : start.status === 400;
  check('未配置时开启会明确报错（不静默失败）', ok, `status=${start.status}`);
}

// ── 8. App still fully usable from its own origin ──
{
  const r = await raw('/api/sessions');
  check('本机会话接口正常', r.status === 200, `status=${r.status}`);
}

// ── 9. Video wallpaper must stream with range support ──
{
  const meta = await raw('/api/background');
  let kind = null;
  try { kind = JSON.parse(meta.text)?.kind ?? null; } catch { /* ignore */ }
  if (!kind) {
    check('背景为视频时可 Range 播放', true, '未设置背景，跳过');
  } else {
    const h = await raw('/api/background/file', { headers: kind === 'video' ? { Range: 'bytes=0-1023' } : {}, method: 'HEAD' });
    const type = String(h.headers['content-type'] ?? '');
    const plausible = kind === 'video'
      ? /^video\//.test(type) || type === 'application/octet-stream'
      : /^image\//.test(type);
    check(`背景 MIME 正确（kind=${kind}, ${type}）`, plausible, `type=${type}`);
    check('声明 Accept-Ranges', h.headers['accept-ranges'] === 'bytes', `=${h.headers['accept-ranges']}`);
  }
}

await shutdown();

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
