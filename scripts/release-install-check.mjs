/**
 * Install the released archive the way a user would, and see whether it runs.
 *
 *   node scripts/release-install-check.mjs
 *
 * This is the check that separates "the archive has the right files" from "the
 * archive works". It extracts to a clean directory, installs dependencies from the
 * lockfile, builds, boots the server, and asserts it answers. Nothing from the
 * development tree is reused except the archive itself.
 *
 * It needs the network (pnpm fetches dependencies) and takes several minutes, so it
 * is deliberately NOT part of `check:all`. Run it before publishing.
 */
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { pickSafePort } from './safe-port.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RELEASE_DIR = join(ROOT, 'release');
const PORT = await pickSafePort(Number(process.env.SHE_INSTALL_TEST_PORT || 18080), [18081,18082,18083,19090,19191]);

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
  }
};

console.log('\n发布包安装验证（解压后真正安装并启动）\n');

if (!existsSync(RELEASE_DIR)) {
  console.error('没有 release/ 目录，先运行 node scripts/release.mjs');
  process.exit(1);
}
const archives = readdirSync(RELEASE_DIR).filter((f) => f.endsWith('.tar.gz'));
if (archives.length === 0) {
  console.error('release/ 里没有 .tar.gz');
  process.exit(1);
}
const archivePath = join(RELEASE_DIR, archives[0]);
console.log(`  归档: ${archives[0]}\n`);

const tmp = mkdtempSync(join(tmpdir(), 'she-install-'));
let root = null;
let child = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, label) {
  process.stdout.write(`  ${label} ... `);
  try {
    execFileSync(cmd, args, {
      cwd: root,
      stdio: 'pipe',
      // pnpm is a shim on Windows, so it needs a shell there.
      shell: process.platform === 'win32',
      timeout: 15 * 60_000,
      env: { ...process.env, CI: '1', SHE_PORT: String(PORT) },
    });
    console.log('ok');
    return { ok: true, out: '' };
  } catch (err) {
    console.log('FAILED');
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
    return { ok: false, out: String(out) };
  }
}

async function waitForHealth(timeoutMs) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) return null;
    await sleep(500);
  }
}

try {
  // ─── Extract ───
  console.log('=== 解压 ===');
  execFileSync('tar', ['-xzf', archivePath, '-C', tmp], { stdio: 'pipe' });
  root = join(tmp, readdirSync(tmp)[0]);
  check('解压成功', existsSync(root), root);
  console.log(`  目录: ${root}\n`);

  // ─── Install ───
  console.log('=== 安装依赖（来自 lockfile，需要网络）===');
  const install = run('pnpm', ['install', '--frozen-lockfile'], 'pnpm install --frozen-lockfile');
  check('依赖安装成功', install.ok, install.out.slice(-400));
  if (!install.ok) throw new Error('安装失败，后续步骤无意义');

  // ─── Build ───
  console.log('\n=== 构建 ===');
  const build = run('pnpm', ['-r', 'build'], 'pnpm -r build');
  check('构建成功', build.ok, build.out.slice(-400));
  if (!build.ok) throw new Error('构建失败');

  // ─── Boot ───
  console.log('\n=== 启动 ===');
  child = spawn('node', ['packages/server/dist/index.js'], {
    cwd: root,
    // A throwaway workspace so the install test cannot touch real data.
    env: {
      ...process.env,
      SHE_PORT: String(PORT),
      SHE_WORKSPACE: root,
      SHE_STATE_DIR: join(root, '.she'),
      // Point the model somewhere unreachable: this checks the HTTP surface, not
      // whether a model answers.
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let serverOut = '';
  child.stdout.on('data', (c) => { serverOut += c; });
  child.stderr.on('data', (c) => { serverOut += c; });

  const health = await waitForHealth(90_000);
  check('服务在 90 秒内响应 /api/health', !!health, serverOut.slice(-500));
  if (health) {
    console.log(`        版本: ${health.version}   KB 就绪: ${health.kbReady}`);
    check('健康检查报告了版本号', typeof health.version === 'string' && health.version.length > 0);
    check('版本号与归档一致（不是 0.0.0）', health.version !== '0.0.0', `version=${health.version}`);
  }

  // ─── The UI must be served ───
  if (health) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(5000) });
      const html = await r.text();
      check('首页返回 HTML', r.ok && /<html|<!doctype/i.test(html), `status=${r.status}`);
      check('首页是构建产物（不是占位）', html.length > 300, `长度 ${html.length}`);
    } catch (err) {
      check('首页可访问', false, err.message);
    }
  }

  // ─── A couple of core APIs ───
  if (health) {
    const apiCheck = async (path, label) => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(5000) });
        check(label, r.ok, `status=${r.status}`);
        return r.ok;
      } catch (err) {
        check(label, false, err.message);
        return false;
      }
    };
    await apiCheck('/api/settings', '/api/settings 可用');
    await apiCheck('/api/metrics', '/api/metrics 可用');
    await apiCheck('/api/schedule', '/api/schedule 可用');
  }

  if (failures > 0) {
    console.log('\n服务端输出（末尾）:');
    console.log(serverOut.split('\n').slice(-25).join('\n'));
  }
} catch (err) {
  check('验证过程未抛异常', false, err.stack ?? err.message);
} finally {
  if (child) {
    try { child.kill(); } catch { /* already gone */ }
    await sleep(1500);
  }
  // Leave the temp tree when something failed, so it can be inspected.
  if (failures === 0) rmSync(tmp, { recursive: true, force: true });
  else console.log(`\n  临时目录保留以便排查: ${tmp}`);
}

console.log(`\n${failures === 0 ? '全部通过 —— 归档可以安装并运行' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
