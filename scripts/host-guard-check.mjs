/**
 * Request guard: deployment access vs. DNS rebinding.
 *
 * The guard has to satisfy two opposing requirements, and getting either wrong is
 * bad in a different way:
 *
 *   - TOO NARROW (the original state): only `127.0.0.1`/`localhost`/`[::1]` were
 *     accepted, so a container, a LAN address, or a reverse proxy was refused
 *     outright. Private/cloud deployment was impossible.
 *   - TOO WIDE: accepting any `Host` re-opens DNS rebinding, where a page the user
 *     visits resolves its own domain to 127.0.0.1 and talks to this server as if it
 *     were same-origin.
 *
 * The middle ground under test: literal IPs are always fine (rebinding needs a
 * hostname), hostnames need explicit opt-in.
 *
 * NOTE on technique: the requests use `node:http`, not `fetch`. `fetch` treats `Host`
 * as a forbidden header and silently sends the host from the URL instead — so a
 * fetch-based version of this check passes no matter what the guard does. That
 * mistake was made once already; it read as a product bug.
 *
 *   node scripts/host-guard-check.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');
const PORT = await pickSafePort(Number(process.env.SHE_GUARD_TEST_PORT || 18080), [18081,18082,18083,19090,19191]);

if (!existsSync(SERVER_ENTRY)) {
  console.error(`找不到 ${SERVER_ENTRY}\n请先 pnpm -r build`);
  process.exit(1);
}

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 300)}`);
  }
};

const workspace = mkdtempSync(join(tmpdir(), 'she-guard-'));
mkdirSync(join(workspace, '.she'), { recursive: true });

/** Send a request with an explicit Host header, over a raw socket. */
function request(hostHeader, { method = 'GET', path = '/api/health', origin } = {}) {
  return new Promise((resolve) => {
    const headers = { Host: hostHeader };
    if (origin) headers.Origin = origin;
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = 2;
    }
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method, path, headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', (err) => resolve(`error: ${err.message}`));
    req.setTimeout(5000, () => { req.destroy(); resolve('timeout'); });
    if (method === 'POST') req.write('{}');
    req.end();
  });
}

/** True once nothing is listening on the port. */
function portFree() {
  return new Promise((resolve) => {
    const probe = http.request({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 800 });
    probe.on('response', (res) => { res.resume(); resolve(false); });
    probe.on('error', () => resolve(true));
    probe.end();
  });
}

let child = null;
async function boot(bindHost, allowedHosts) {
  // Wait for the previous instance to fully release the port AND its database file.
  for (let i = 0; i < 40 && !(await portFree()); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }

  writeFileSync(join(workspace, '.env'), [
    'OPENAI_API_KEY=test-not-used',
    'OPENAI_BASE_URL=http://127.0.0.1:1',
    `SHE_WORKSPACE=${workspace.replace(/\\/g, '/')}`,
    `SHE_PORT=${PORT}`,
    `SHE_HOST=${bindHost}`,
    `SHE_ALLOWED_HOSTS=${allowedHosts ?? ''}`,
  ].join('\n'), 'utf8');

  child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: { ...process.env, SHE_PORT: String(PORT), SHE_ENV_FILE: join(workspace, '.env'), SHE_WORKSPACE: workspace, SHE_APP_DIR: join(workspace, 'appdir'), SHE_STATE_DIR: workspace },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) return out;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > 30_000) {
      console.error('服务未能就绪:\n' + out.slice(-700));
      return null;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}

async function shutdown() {
  if (!child) return;
  child.kill();
  child = null;
  for (let i = 0; i < 40 && !(await portFree()); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

console.log('\n请求守卫检查（真实服务，临时工作区）\n');

try {
  // ── Bound to loopback: the safe default ──
  console.log('=== 默认（只绑本机）===');
  if (!await boot('127.0.0.1', '')) throw new Error('启动失败');
  {
    check('localhost 可用', await request(`localhost:${PORT}`) === 200);
    check('127.0.0.1 可用', await request(`127.0.0.1:${PORT}`) === 200);
    // A literal IP is allowed by rule 2, which is what makes LAN use work.
    check('局域网 IP 可用',
      await request(`192.168.1.50:${PORT}`) === 200,
      String(await request(`192.168.1.50:${PORT}`)));
    // Not configured, and a NAME rather than an IP → refused (rebinding defence).
    const evil = await request(`evil.example.com:${PORT}`);
    check('未配置的域名被拒（防 DNS rebinding）', evil === 403, `status=${evil}`);
    /*
     * An empty Host is not exercised here: `node:http` substitutes the connection's
     * own address when the header is blank, so a test cannot produce it. The guard
     * returns false for an empty value, which is the correct behaviour for the
     * clients that can produce one (HTTP/1.0, or a hand-rolled socket).
     */
  }
  await shutdown();

  // ── A hostname explicitly allowed ──
  console.log('\n=== 配置了 SHE_ALLOWED_HOSTS ===');
  // Written WITHOUT ports on purpose: that is how an operator writes it, while a
  // browser sends the port. Matching only the exact string would make a correct
  // entry silently do nothing.
  if (!await boot('127.0.0.1', 'she.example.com,panel.lan')) throw new Error('启动失败');
  {
    const a = await request(`she.example.com:${PORT}`);
    check('只写域名、请求带端口 —— 仍然被接受', a === 200, `status=${a}`);
    const b = await request(`panel.lan:${PORT}`);
    check('第二个域名同样生效', b === 200, `status=${b}`);
    const c = await request(`other.example.com:${PORT}`);
    check('未配置的域名仍被拒', c === 403, `status=${c}`);
  }
  await shutdown();

  // ── Bound externally (container / LAN): the deployment case ──
  console.log('\n=== SHE_HOST=0.0.0.0（容器/局域网部署）===');
  if (!await boot('0.0.0.0', '')) throw new Error('启动失败');
  {
    check('本机 localhost 仍可用', await request(`localhost:${PORT}`) === 200);
    const ip = await request(`172.17.0.1:${PORT}`);
    check('容器内的 IP 可用', ip === 200, `status=${ip}`);
    const evil = await request(`sneaky.example.com:${PORT}`);
    check('未配置的域名仍被拒（绑定地址不影响这条规则）', evil === 403, `status=${evil}`);
  }
  await shutdown();

  // ── Wildcard, for a reverse proxy that rewrites Host ──
  console.log('\n=== SHE_ALLOWED_HOSTS=* ===');
  if (!await boot('0.0.0.0', '*')) throw new Error('启动失败');
  {
    const any = await request(`anything.internal:${PORT}`);
    check('通配符下任意域名可用（反代场景，显式选择）', any === 200, `status=${any}`);
  }
  await shutdown();

  // ── Origin must match, so a cross-site page cannot drive the API ──
  console.log('\n=== Origin 校验 ===');
  if (!await boot('127.0.0.1', '')) throw new Error('启动失败');
  {
    const foreign = await request(`127.0.0.1:${PORT}`, {
      method: 'POST', path: '/api/chat', origin: 'http://evil.example.com',
    });
    check('陌生 Origin 被拒', foreign === 403, `status=${foreign}`);

    const same = await request(`127.0.0.1:${PORT}`, {
      method: 'POST', path: '/api/chat', origin: `http://127.0.0.1:${PORT}`,
    });
    // Not 403: the request is allowed through to the route, which then rejects the
    // body. The point is that the guard did not block it.
    check('同源 Origin 放行', same !== 403, `status=${same}`);
  }
} catch (err) {
  check('检查过程未抛异常', false, err.stack ?? err.message);
} finally {
  await shutdown();
  removeTempDir(workspace);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
