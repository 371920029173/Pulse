/**
 * Custom stylesheet regression checks.
 *
 *   node scripts/theme-check.mjs
 *
 * Boots its OWN server on a throwaway workspace, so the result does not depend on whether
 * a development instance happens to be running.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE CHECKS EXIST
 *
 * A stylesheet is the one input in this app that can make the app unusable. Everything
 * here is about the two properties that keep that recoverable:
 *
 *   1. **A stylesheet that hides the UI is refused before it is saved**, with the line
 *      number, so the user never ends up staring at a blank page wondering which of their
 *      rules did it.
 *   2. **The way out does not need the interface.** `POST /api/theme/disable` is asserted
 *      here as plain HTTP, precisely because the situation it exists for is one where
 *      nothing on screen can be clicked.
 *
 * The unit tests cover the validator's logic; these cover the wiring — that a refused save
 * really does not reach the disk, and that disabling really does keep the content.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { request } from 'node:http';
import {
  writeFileSync, readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync,
  chmodSync, symlinkSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pickSafePort } from './safe-port.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');

const EXTERNAL = process.env.SHE_API ?? null;
const PORT = await pickSafePort(Number(process.env.SHE_THEME_TEST_PORT || 18080), [18081,18082,18083,19090,19191]);
const BASE = EXTERNAL ?? `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

function raw(path, { method = 'GET', body, raw: rawBody } = {}) {
  return new Promise((resolve) => {
    const u = new URL(BASE + path);
    const payload = rawBody !== undefined
      ? Buffer.from(rawBody)
      : body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
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

const json = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

/* ─── Own server ─── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;
let workspace = null;
let appDirPath = null;

async function boot() {
  if (EXTERNAL) {
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

  workspace = mkdtempSync(join(tmpdir(), 'she-theme-'));
  mkdirSync(join(workspace, '.she'), { recursive: true });
  /*
   * The stylesheet lives in the app directory, which defaults to the real `~/.she-app`.
   * Pointing it at a throwaway directory keeps these checks from writing into the
   * developer's own configuration — and doubles as a check that the override works.
   */
  appDirPath = join(workspace, 'appdir');
  mkdirSync(appDirPath, { recursive: true });
  writeFileSync(join(workspace, '.env'), [
    'OPENAI_API_KEY=not-used-by-these-checks',
    'OPENAI_BASE_URL=http://127.0.0.1:1',
    `SHE_WORKSPACE=${workspace.replace(/\\/g, '/')}`,
    `SHE_APP_DIR=${appDirPath.replace(/\\/g, '/')}`,
    `SHE_PORT=${PORT}`,
  ].join('\n'), 'utf8');

  child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    /*
     * Pin the settings this check depends on IN THE CHILD ENVIRONMENT, not only in the .env
     * file it writes.
     *
     * Ambient environment variables beat values in `.env`, so a developer who has ever
     * exported `SHE_PORT` (or `SHE_WORKSPACE`) makes this check boot on their port instead of
     * its own — failing with a confusing EADDRINUSE, or worse, probing the dev server that is
     * already running and reporting on that instead of on this code.
     */
    env: {
      ...process.env,
      SHE_ENV_FILE: join(workspace, '.env'),
      SHE_PORT: String(PORT),
      SHE_WORKSPACE: workspace,
      SHE_APP_DIR: appDirPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });

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
  if (child) { child.kill(); child = null; await sleep(600); }
  if (workspace) {
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
    workspace = null;
    appDirPath = null;
  }
}

/** The stylesheet file, when we booted our own server. */
const cssPath = () => (appDirPath ? join(appDirPath, 'theme.css') : null);

await boot();

// ── 1. Starts empty and enabled ──
{
  const r = await raw('/api/theme');
  const j = json(r);
  check('初始状态可读', r.status === 200 && j !== null, `status=${r.status}`);
  check('初始没有样式表且为启用', j?.css === '' && j?.enabled === true,
    `css=${JSON.stringify(j?.css)?.slice(0, 20)} enabled=${j?.enabled}`);
}

// ── 2. 【关键】会锁死界面的样式必须被拦下，且不能落盘 ──
{
  const brick = ':root {\n  --accent: red;\n}\n\nhtml {\n  display: none;\n}\n';
  const r = await raw('/api/theme', { method: 'PUT', body: { css: brick } });
  const j = json(r);
  check('隐藏界面的样式返回 400', r.status === 400, `status=${r.status}`);
  check('返回了具体行号', j?.issues?.[0]?.line === 5, `line=${j?.issues?.[0]?.line}`);
  check('说明白了为什么（而不是只说"不合法"）', /display|无法操作/.test(j?.issues?.[0]?.message ?? ''),
    (j?.issues?.[0]?.message ?? '').slice(0, 40));

  const after = json(await raw('/api/theme'));
  check('被拒绝的样式没有落盘', after?.css === '', `css=${JSON.stringify(after?.css)?.slice(0, 20)}`);
  if (cssPath()) {
    check('磁盘上确实没有这个文件', !existsSync(cssPath()), cssPath());
  }
}

// ── 3. 花括号不平衡也必须拦下（它会吞掉后面所有内容） ──
{
  const r = await raw('/api/theme', { method: 'PUT', body: { css: '.a {\n  color: red;\n\n.b { color: blue; }' } });
  const j = json(r);
  check('花括号不匹配被拦下', r.status === 400 && /缺少/.test(j?.issues?.[0]?.message ?? ''),
    `status=${r.status} msg=${(j?.issues?.[0]?.message ?? '').slice(0, 30)}`);
}

// ── 4. 远程 @import 必须被拦下（会泄露本机在跑这个应用） ──
{
  const r = await raw('/api/theme', { method: 'PUT', body: { css: '@import url(https://evil.example/x.css);' } });
  check('远程 @import 被拦下', r.status === 400, `status=${r.status}`);
}

// ── 5. ?force=1 可以覆盖（用户可能确实知道自己在做什么） ──
{
  const brick = 'html { display: none; }';
  const r = await raw('/api/theme?force=1', { method: 'PUT', body: { css: brick } });
  const j = json(r);
  check('强制保存可以绕过（用户有权这么做）', r.status === 200 && j?.saved === true, `status=${r.status}`);
  check('强制保存会明确标记出来', j?.forced === true, `forced=${j?.forced}`);

  const after = json(await raw('/api/theme'));
  check('强制保存的内容确实落盘了', after?.css === brick, `css=${JSON.stringify(after?.css)?.slice(0, 30)}`);
}

// ── 6. 【关键】逃生通道：停用后内容必须保留 ──
{
  const r = await raw('/api/theme/disable', { method: 'POST' });
  check('停用接口可用（不依赖界面）', r.status === 200, `status=${r.status}`);

  const j = json(await raw('/api/theme'));
  check('停用后 enabled=false', j?.enabled === false, `enabled=${j?.enabled}`);
  check('停用不会丢掉内容（否则用户要重写一遍）', j?.css === 'html { display: none; }',
    `css=${JSON.stringify(j?.css)?.slice(0, 30)}`);

  const on = await raw('/api/theme/enable', { method: 'POST' });
  check('可以重新启用', on.status === 200 && json(await raw('/api/theme'))?.enabled === true);
}

// ── 7. 恢复上一版 ──
{
  const before = json(await raw('/api/theme'))?.css;

  // Save a second version, which pushes the first into `.prev`.
  await raw('/api/theme', { method: 'PUT', body: { css: ':root { --accent: red; }' } });
  const r = await raw('/api/theme/revert', { method: 'POST' });
  const j = json(r);
  check('恢复上一版成功', r.status === 200 && j?.ok === true, `status=${r.status}`);
  check('恢复回来的正是上一版内容', j?.css === before, `got=${JSON.stringify(j?.css)?.slice(0, 30)}`);

  const again = await raw('/api/theme/revert', { method: 'POST' });
  check('再恢复一次可以撤销恢复（不是死胡同）', again.status === 200, `status=${again.status}`);
}

// ── 8. 体积上限 ──
{
  const huge = `/* ${'x'.repeat(300 * 1024)} */`;
  const r = await raw('/api/theme', { method: 'PUT', body: { css: huge } });
  check('超大样式表被拦下（否则每次重绘都变慢）', r.status === 400, `status=${r.status}`);
}

// ── 9. 参数校验：明确的 400 而不是 500 ──
{
  const r = await raw('/api/theme', { method: 'PUT', body: { css: 12345 } });
  check('css 不是字符串时返回 400', r.status === 400, `status=${r.status}`);
}

// ── 9b. 【关键】校验接口：边打字边提示的实现基础 ──
//      The editor calls this on every keystroke so a problem is explained while it is being
//      typed, rather than only when Save is pressed. It must validate WITHOUT saving —
//      otherwise "check my draft" would silently commit it.
{
  const brick = 'html {\n  display: none;\n}';
  const r = await raw('/api/theme/validate', { method: 'POST', body: { css: brick } });
  const j = json(r);
  check('校验接口可用', r.status === 200 && j?.ok === false, `status=${r.status}`);
  check('校验接口给出行号', j?.issues?.[0]?.line === 1, `line=${j?.issues?.[0]?.line}`);

  const after = json(await raw('/api/theme'));
  check('校验不会顺手把草稿保存了', !(after?.css ?? '').includes('display: none'),
    `css=${JSON.stringify(after?.css)?.slice(0, 40)}`);

  const ok = json(await raw('/api/theme/validate', { method: 'POST', body: { css: ':root { --accent: red; }' } }));
  check('合法样式校验通过', ok?.ok === true, `ok=${ok?.ok}`);

  const bad = await raw('/api/theme/validate', { method: 'POST', body: { css: 123 } });
  check('非字符串草稿返回 400（不是 500）', bad.status === 400, `status=${bad.status}`);
}

// ── 10. 删除会清空文件但留一份备份 ──
{
  const r = await raw('/api/theme', { method: 'DELETE' });
  check('删除可用', r.status === 200, `status=${r.status}`);
  const j = json(await raw('/api/theme'));
  check('删除后回到空样式', j?.css === '', `css=${JSON.stringify(j?.css)?.slice(0, 20)}`);
  if (cssPath()) {
    check('删除后留了一份备份（误删可找回）', existsSync(`${cssPath()}.prev`), `${cssPath()}.prev`);
  }
}

// ── 11. 手写的样式文件也要能被读到 ──
//      The file is documented as hand-editable, so a stylesheet written directly to disk
//      (or by a dotfiles manager) must be picked up without going through the API.
if (cssPath()) {
  writeFileSync(cssPath(), ':root { --accent: #ff7a59; }', 'utf8');
  const j = json(await raw('/api/theme'));
  check('直接编辑磁盘上的 theme.css 会被读取', j?.css === ':root { --accent: #ff7a59; }',
    `css=${JSON.stringify(j?.css)?.slice(0, 40)}`);
  check('手写的样式也会被检查', Array.isArray(j?.validation?.issues), `issues=${j?.validation?.issues?.length}`);

  /*
   * A BOM, because that is what Notepad and PowerShell's `Set-Content -Encoding utf8` produce.
   *
   * Two separate things are checked, and they are not the same claim:
   *   - the brick check still recognizes the root selector (implicit, via `trim()` treating
   *     U+FEFF as whitespace — non-obvious and worth pinning);
   *   - the file is read back without the BOM, so the editor does not hand it to the user to
   *     save again.
   */
  writeFileSync(cssPath(), '\uFEFFhtml { display: none; }', 'utf8');
  const bom = json(await raw('/api/theme'));
  check('带 BOM 时仍能认出 root 选择器（靠 trim 的隐式行为，别退回去）',
    bom?.validation?.ok === false, `ok=${bom?.validation?.ok}`);
  check('带 BOM 时提示里确实指出了 html',
    /html/.test(bom?.validation?.issues?.[0]?.message ?? ''), (bom?.validation?.issues?.[0]?.message ?? '').slice(0, 40));
  check('读取时不把 BOM 交还给编辑器（否则会被反复保存回去）',
    typeof bom?.css === 'string' && bom.css.charCodeAt(0) !== 0xfeff,
    `首字符码=${bom?.css?.charCodeAt?.(0)}`);

  // 破坏状态文件，服务必须照常工作
  writeFileSync(join(appDirPath, 'theme-state.json'), '{"enabled": tru', 'utf8');
  const r = await raw('/api/theme');
  check('状态文件损坏时接口不报 500（界面照常启动）', r.status === 200, `status=${r.status}`);
}

// ── 12. 异常输入不能让服务挂掉，也不能报错不明确 ──
//
// The stylesheet is a file the user is invited to edit with anything, so the ways it can be
// wrong are not limited to "valid CSS" and "invalid CSS". Each case below is a state a real
// editor, a dotfiles manager, or a simple mistake produces.
if (cssPath()) {
  const appDir = dirname(cssPath());

  /*
   * Non-UTF-8 bytes.
   *
   * A Chinese Windows user editing theme.css in a GBK editor — or any stray binary byte — must
   * not break the endpoint. Node replaces invalid sequences with U+FFFD, so the expectation is
   * a readable file with replacement characters, not an error.
   */
  {
    writeFileSync(cssPath(), Buffer.concat([
      Buffer.from(':root { --accent: #ff7a59; }\n/* ', 'utf8'),
      // 0xD6 0xD0 is "中" in GBK, and is not valid UTF-8.
      Buffer.from([0xd6, 0xd0]),
      Buffer.from(' */\n', 'utf8'),
    ]));
    const j = json(await raw('/api/theme'));
    check('非 UTF-8 字节不会让接口报错', typeof j?.css === 'string', `css=${typeof j?.css}`);
    check('非 UTF-8 内容按替换字符读取（不是崩掉）',
      j?.css?.includes('#ff7a59') === true, `css=${JSON.stringify(j?.css)?.slice(0, 50)}`);
  }

  // A directory where the file should be: `New-Item -ItemType Directory theme.css`, or a
  // mis-typed path.
  {
    rmSync(cssPath(), { force: true });
    mkdirSync(cssPath(), { recursive: true });
    const j = json(await raw('/api/theme'));
    check('theme.css 是目录时不报 500（界面照常启动）', typeof j?.css === 'string', `css=${typeof j?.css}`);
    const save = await raw('/api/theme', { method: 'PUT', body: { css: ':root { --accent: red; }' } });
    check('往目录上写时给出明确错误而不是假装成功',
      save.status >= 400 && save.status < 600, `status=${save.status}`);
    // The message has to name the file and the cause. A bare "Internal Server Error" tells the
    // user nothing about which file is wrong or that the problem is not their CSS.
    check('往目录上写时说明是目录而不是泛泛的 500',
      /目录/.test(json(save)?.error ?? ''), json(save)?.error ?? '(空响应体)');
    rmSync(cssPath(), { recursive: true, force: true });
  }

  /*
   * Read-only file.
   *
   * The requirement is that the outcome and the report agree. A silent success would leave the
   * user believing their change was stored when it was not — the failure mode this whole
   * feature is built to avoid.
   */
  {
    writeFileSync(cssPath(), ':root { --accent: #111111; }', 'utf8');
    const before = readFileSync(cssPath(), 'utf8');
    try {
      chmodSync(cssPath(), 0o444);
      const save = await raw('/api/theme', { method: 'PUT', body: { css: ':root { --accent: #222222; }' } });
      const after = readFileSync(cssPath(), 'utf8');
      if (save.status === 200) {
        check('只读文件：报成功就必须真的写进去了', after !== before, '报成功但内容没变');
      } else {
        check('只读文件：明确失败而不是静默丢失', save.status >= 400, `status=${save.status}`);
        check('只读文件：原内容未被破坏', after === before, `写后被改成 ${JSON.stringify(after).slice(0, 40)}`);
        // Same reasoning as the directory case: the message must be actionable.
        check('只读文件：错误信息说明是权限问题',
          /权限|只读/.test(json(save)?.error ?? ''), json(save)?.error ?? '(空响应体)');
      }
    } catch (e) {
      check('只读文件场景可跳过', true, `无法设只读：${String(e.message).slice(0, 40)}`);
    } finally {
      try { chmodSync(cssPath(), 0o644); } catch { /* ignore */ }
    }
  }

  // A symlink, which is how a dotfiles manager wires a shared config in.
  {
    const target = join(appDir, 'real-theme.css');
    writeFileSync(target, ':root { --accent: #00ff00; }', 'utf8');
    rmSync(cssPath(), { force: true });
    try {
      symlinkSync(target, cssPath());
      const j = json(await raw('/api/theme'));
      check('theme.css 是符号链接时能读到目标内容',
        j?.css?.includes('#00ff00') === true, `css=${JSON.stringify(j?.css)?.slice(0, 40)}`);
    } catch (e) {
      check('符号链接场景可跳过', true, `无法建链：${String(e.message).slice(0, 40)}`);
    } finally {
      try { rmSync(cssPath(), { force: true }); } catch { /* ignore */ }
      try { rmSync(target, { force: true }); } catch { /* ignore */ }
    }
  }

  /*
   * Rapid successive saves.
   *
   * Guards against a lost update and against a half-written state file. The requirement is
   * narrow: no 5xx, the file stays parseable, and its content is one of the requests rather
   * than a blend of several.
   */
  {
    const saves = [];
    for (let i = 0; i < 8; i++) {
      saves.push(raw('/api/theme', { method: 'PUT', body: { css: `:root { --accent: #00000${i}; }` } }));
    }
    const statuses = (await Promise.all(saves)).map((x) => x.status);
    check('并发保存不互相打架（没有 5xx）', statuses.every((s) => s === 200), statuses.join(','));
    const j = json(await raw('/api/theme'));
    check('并发保存后状态仍可解析', typeof j?.css === 'string', `css=${typeof j?.css}`);
    check('并发保存后留下的是其中一次的完整内容（没有写坏）',
      /^:root \{ --accent: #00000\d; \}$/.test((j?.css ?? '').trim()), JSON.stringify(j?.css));
  }

  // Empty-but-not-empty, and CRLF (the default on Windows).
  {
    writeFileSync(cssPath(), '   \n\t\n', 'utf8');
    const blank = json(await raw('/api/theme'));
    check('只有空白的样式表视为空', blank?.css?.trim() === '', JSON.stringify(blank?.css));
    check('只有空白时不报错', blank?.validation?.ok === true, JSON.stringify(blank?.validation?.issues));

    writeFileSync(cssPath(), ':root {\r\n  --accent: #ff7a59;\r\n}\r\n', 'utf8');
    const crlf = json(await raw('/api/theme'));
    check('CRLF 换行的文件能正常解析',
      crlf?.validation?.issues?.length === 0, JSON.stringify(crlf?.validation?.issues));
    check('CRLF 时变量仍被识别', crlf?.validation?.stats?.variables === 1,
      `vars=${crlf?.validation?.stats?.variables}`);
  }

  /*
   * A stylesheet that tries to close the element it is injected into.
   *
   * The client assigns with `textContent`, so this is inert data — the browser re-parses it as
   * CSS, fails, and moves on. The server's job is only to store it faithfully rather than
   * "sanitising" it into something else; the escaping happens at the injection site, and that
   * is where it is asserted (see the browser check in the notes below).
   */
  {
    const payload = ':root { --x: 1; }\n</style><script>window.__pwned = 1</script>\n';
    const save = await raw('/api/theme', { method: 'PUT', body: { css: payload } });
    check('尝试闭合 style 标签的内容被正常接受', save.status === 200, `status=${save.status}`);
    const j = json(await raw('/api/theme'));
    check('原样存储（注入安全由客户端 textContent 保证，服务端不做有损处理）',
      j?.css === payload, JSON.stringify(j?.css).slice(0, 60));
  }
}

/*
 * ── 13. 体积与性能 ──
 *
 * The validator runs on every keystroke in the editor (debounced) and on every save, and is pure
 * string analysis. A stylesheet near the size limit must not make the editor feel dead — an
 * O(n²) scan once made this path take seconds, which is a real regression risk because the
 * algorithm looks linear at a glance.
 */
{
  // A large but realistic sheet: a few thousand rules, near the 256 KB cap.
  const rule = ':root { --accent: #ff7a59; --radius-md: 6px; }\n.x%d { color: #%s; padding: %dpx; }\n';
  let big = '';
  let i = 0;
  while (Buffer.byteLength(big, 'utf8') < 200 * 1024) {
    const color = ((i * 7919) % 0xffffff).toString(16).padStart(6, '0');
    big += rule.replace('%d', String(i)).replace('%s', color).replace('%d', String(i % 40));
    i++;
  }
  const kb = Math.round(Buffer.byteLength(big, 'utf8') / 1024);

  const t0 = Date.now();
  const v = json(await raw('/api/theme/validate', { method: 'POST', body: { css: big } }));
  const ms = Date.now() - t0;

  check(`${kb}KB 样式表能校验通过`, v?.ok === true, JSON.stringify(v?.issues)?.slice(0, 80));
  check(`${kb}KB 时规则数被正确统计`, (v?.stats?.rules ?? 0) > 1000, `rules=${v?.stats?.rules}`);
  check(`${kb}KB 校验在 1s 内完成（编辑器每次按键都要跑）`, ms < 1000, `${ms}ms`);

  const save = await raw('/api/theme', { method: 'PUT', body: { css: big } });
  check('接近上限的样式表可以保存', save.status === 200, `status=${save.status}`);
  const back = json(await raw('/api/theme'));
  check('大样式表读回后完全一致（没有截断）', back?.css === big,
    `读回 ${Buffer.byteLength(back?.css ?? '', 'utf8')} 字节 vs 写入 ${Buffer.byteLength(big, 'utf8')} 字节`);

  // Just over the cap must be a clean refusal that leaves the good file alone.
  const over = `/* ${'x'.repeat(300 * 1024)} */`;
  const tooBig = await raw('/api/theme', { method: 'PUT', body: { css: over } });
  check('超过上限是明确的 400 而不是崩溃', tooBig.status === 400, `status=${tooBig.status}`);
  const stillGood = json(await raw('/api/theme'));
  check('超限保存被拒绝后原有样式完好', stillGood?.css === big, '原内容被覆盖');
}

// ── 14. 没有样式时的边角情况 ──
{
  /*
   * Deleting is recoverable, deliberately.
   *
   * `DELETE /api/theme` keeps a copy in `theme.css.prev`, so "I deleted my theme by mistake" has
   * an answer. Asserted here because it is a design decision that a future cleanup could undo:
   * the obvious implementation of "clear" is to remove both files.
   */
  await raw('/api/theme', { method: 'PUT', body: { css: ':root { --accent: #abcdef; }' } });
  await raw('/api/theme', { method: 'DELETE' });
  const afterDelete = json(await raw('/api/theme'));
  check('删除后内容为空', afterDelete?.css === '', JSON.stringify(afterDelete?.css));
  const restored = await raw('/api/theme/revert', { method: 'POST' });
  check('删除是可以恢复的（误删不该等于永久丢失）', restored.status === 200, `status=${restored.status}`);
  check('恢复回来的正是删除前的内容',
    json(restored)?.css === ':root { --accent: #abcdef; }\n' || json(restored)?.css === ':root { --accent: #abcdef; }',
    JSON.stringify(json(restored)?.css));

  /*
   * `?theme=off` with nothing to disable must be a harmless no-op rather than an error. The
   * escape hatch is something a panicking user types; failing there would be cruel, and it is
   * also reachable from a stale bookmark or a shared link.
   */
  const off = await raw('/api/theme/disable', { method: 'POST' });
  check('没有样式时停用也不报错（逃生通道要永远可用）', off.status === 200, `status=${off.status}`);
  const j = json(await raw('/api/theme'));
  check('没有样式时停用后状态为 disabled', j?.enabled === false, `enabled=${j?.enabled}`);

  await raw('/api/theme/enable', { method: 'POST' });
  const on = json(await raw('/api/theme'));
  check('空样式也能重新启用', on?.enabled === true, `enabled=${on?.enabled}`);

  /*
   * With genuinely no previous version, reverting must explain itself.
   *
   * Reached by removing BOTH files — which is what a user does if they delete `theme.css` and
   * `theme.css.prev` by hand, or on a fresh install.
   */
  if (cssPath()) {
    rmSync(cssPath(), { force: true });
    rmSync(`${cssPath()}.prev`, { force: true });
    const rv = await raw('/api/theme/revert', { method: 'POST' });
    check('没有上一版时恢复给出明确 400', rv.status === 400, `status=${rv.status}`);
    check('没有上一版时说明了原因', /没有上一版/.test(json(rv)?.error ?? ''), json(rv)?.error ?? '(空)');
  }
}

// ── 15. 主题是全局偏好，不跟着工作区走 ──
//
// The wallpaper had exactly this bug: it was stored next to the sessions, so switching workspace
// silently changed the user's background. A stylesheet stored the same way would silently
// restyle the whole app on every switch — and the user would reasonably conclude they had broken
// something. The file lives in the app directory for that reason, and this pins it.
if (workspace) {
  const other = join(workspace, 'other-workspace');
  mkdirSync(join(other, '.she'), { recursive: true });

  await raw('/api/theme', { method: 'PUT', body: { css: ':root { --accent: #ff7a59; }' } });
  const before = json(await raw('/api/theme'));

  const sw = await raw('/api/workspaces/switch', { method: 'POST', body: { root: other } });
  check('切换工作区成功（否则本检查无从谈起）', sw.status === 200, `status=${sw.status}`);

  const after = json(await raw('/api/theme'));
  check('换工作区后样式内容不变', after?.css === before?.css,
    `${JSON.stringify(before?.css)?.slice(0, 30)} → ${JSON.stringify(after?.css)?.slice(0, 30)}`);
  check('换工作区后启用状态不变', after?.enabled === before?.enabled,
    `${before?.enabled} → ${after?.enabled}`);
  check('换工作区后文件位置不变', after?.path === before?.path, `${before?.path} → ${after?.path}`);
  /*
   * The invariant is "the stylesheet lives with the app's own state, not with the workspace's".
   *
   * Asserted as "under the app directory" rather than "outside the workspace" — in production
   * those are different places (`~/.she-app` versus the project), but this check deliberately
   * nests its app directory inside its throwaway workspace so cleanup is a single rm, and the
   * looser phrasing would fail on the harness rather than on the code.
   */
  check('样式文件位于应用目录（而不是工作区的 .she 里）',
    typeof after?.path === 'string' && appDirPath !== null && after.path.startsWith(appDirPath)
      && !after.path.startsWith(join(workspace, '.she')),
    after?.path ?? '(空)');

  // Switch back so nothing downstream is confused about which workspace is active.
  await raw('/api/workspaces/switch', { method: 'POST', body: { root: workspace } });
}

await shutdown();

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
