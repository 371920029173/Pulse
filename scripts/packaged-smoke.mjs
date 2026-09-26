// Smoke-test the PACKAGED desktop build: boot its bundled server and probe it.
// The unpacked tree is what the installer installs, so this checks the artifact rather
// than the source tree.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/*
 * Which runtime to smoke-test.
 *
 * Default is the unpacked tree inside `release/desktop` — that is literally what the installer
 * copies, so it is the artifact a user receives. `SHE_RUNTIME=staged` points at
 * `packages/desktop/runtime` instead, which is useful while iterating on the staging step without
 * paying for a full electron-builder run.
 */
const RUNTIME = process.env.SHE_RUNTIME === 'staged'
  ? join(ROOT, 'packages', 'desktop', 'runtime')
  : join(ROOT, 'release', 'desktop', 'win-unpacked', 'resources', 'runtime');

const SERVER_ENTRY = join(RUNTIME, 'server', 'dist', 'index.js');
const PORT = Number(process.env.SHE_PACKAGED_TEST_PORT || 18500);

if (!existsSync(SERVER_ENTRY)) {
  console.error(`找不到打包的服务端: ${SERVER_ENTRY}\n先跑 pnpm pack:win（或 node scripts/stage-desktop-runtime.mjs）`);
  process.exit(1);
}
console.log(`  运行时: ${RUNTIME}`);

const ws = mkdtempSync(join(tmpdir(), 'she-packed-'));
mkdirSync(join(ws, '.she'), { recursive: true });
writeFileSync(join(ws, '.env'), [
  'OPENAI_API_KEY=stub',
  'OPENAI_BASE_URL=http://127.0.0.1:1',
  `SHE_WORKSPACE=${ws.replace(/\\/g, '/')}`,
  `SHE_PORT=${PORT}`,
  '',
].join('\n'), 'utf8');

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { failures++; if (detail) console.log(`        ${String(detail).slice(0, 300)}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(5000) });
    return { status: r.status, text: await r.text() };
  } catch (e) { return { status: 0, text: String(e.message) }; }
}

const child = spawn('node', [SERVER_ENTRY], {
  cwd: join(RUNTIME, 'server'),
  env: {
    ...process.env,
    SHE_ENV_FILE: join(ws, '.env'),
    SHE_WORKSPACE: ws,
    SHE_APP_DIR: join(ws, 'appdir'),
    SHE_PORT: String(PORT),
    /*
     * Mirror what the desktop launcher passes. `main.cjs` sets `SHE_UI_DIR` to
     * `<runtime>/ui`, and without it the server falls back to a development path that does not
     * exist here — so the UI would 404 and this check would report a product failure that is
     * really an incomplete imitation of the launcher.
     */
    SHE_UI_DIR: join(RUNTIME, 'ui'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let out = '';
child.stdout.on('data', (c) => { out += c; });
child.stderr.on('data', (c) => { out += c; });

console.log('\n打包产物冒烟测试（跑 win-unpacked 里那套服务端）\n');

try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    if ((await api('/api/health')).status === 200) { up = true; break; }
    await sleep(500);
  }
  check('打包的服务端能启动', up, out.slice(-800));

  if (up) {
    const health = await api('/api/health');
    check('健康检查返回 200', health.status === 200);

    // The UI the installer ships must be the current one.
    const ui = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
    check('界面能被提供', ui.includes('<div id="root"') || ui.includes('<script'), ui.slice(0, 200));

    const assets = [...ui.matchAll(/src="([^"]+\.js)"/g)].map((m) => m[1]);
    check('页面引用了脚本', assets.length > 0, JSON.stringify(assets));

    if (assets[0]) {
      const bundle = await fetch(`http://127.0.0.1:${PORT}${assets[0]}`).then((r) => r.text());
      check('打包的界面含会话移植文案', bundle.includes('移植为对话记录'));
      check('打包的界面已移除旧的批量导入按钮', !bundle.includes('一键全部导入'));
      check('打包的界面含合库入口', bundle.includes('合并另一库'));
    }

    // Endpoints added in this round.
    const plugins = await api('/api/plugins');
    check('插件接口可用', plugins.status === 200, `status=${plugins.status}`);
    const tasks = await api('/api/tasks');
    check('任务接口可用（mark-stale 路由所在）', tasks.status === 200, `status=${tasks.status}`);
    const kb = await api('/api/kb/tree');
    check('知识库接口可用', kb.status === 200, `status=${kb.status}`);

    /*
     * Attachments, end to end inside the artifact.
     *
     * The route existing is not the interesting half: an upload writes to `.she/attachments` under
     * the workspace and hands back a path the providers read on every later turn, so the thing to
     * prove is that the file survives the round trip and comes back served. A path that is written
     * but unreadable looks identical to a working one until the model is asked about the picture.
     */
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );
    let uploaded = null;
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/attachments`, {
        method: 'POST',
        headers: { 'content-type': 'image/png', 'x-filename': 'pasted.png', 'x-mime': 'image/png' },
        body: png,
        signal: AbortSignal.timeout(5000),
      });
      uploaded = r.ok ? await r.json() : null;
      check('附件上传接口可用', r.ok, `status=${r.status}`);
    } catch (e) { check('附件上传接口可用', false, String(e.message)); }

    if (uploaded) {
      check('上传返回的是工作区里的绝对路径', typeof uploaded.path === 'string' && uploaded.path.includes('.she'), uploaded.path);
      check('上传保留了可读的原名后缀', String(uploaded.name).endsWith('pasted.png'), uploaded.name);
      const back = await fetch(`http://127.0.0.1:${PORT}${uploaded.url}`, { signal: AbortSignal.timeout(5000) });
      const body = Buffer.from(await back.arrayBuffer());
      check('附件能按返回的地址读回来（内容一致）', back.status === 200 && body.equals(png), `status=${back.status} bytes=${body.length}`);
      const escape = await api(`/api/attachments/file?name=${encodeURIComponent('..%2F..%2F.env')}`);
      check('附件回读拒绝目录穿越', escape.status === 400 || escape.status === 403, `status=${escape.status}`);
    }
  }
} finally {
  try { child.kill(); } catch { /* gone */ }
  await sleep(700);
  rmSync(ws, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
