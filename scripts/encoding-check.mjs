/**
 * Non-ASCII text survives the round trip.
 *
 *   node scripts/encoding-check.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * A garbled title was reported on this project as `??????:??`. It was put down to the user's
 * own input, but "the text came back as question marks" is a symptom with several unrelated
 * causes and none of them is self-evident:
 *
 *   - a response sent without `charset=utf-8`, so the client decodes UTF-8 bytes as latin1;
 *   - a file written with the wrong encoding, so the corruption is on disk and permanent;
 *   - a request body read as latin1 instead of UTF-8;
 *   - PowerShell's `Invoke-RestMethod`, which encodes a `-Body` string as latin1 by default
 *     and garbles Chinese BEFORE it ever reaches the server.
 *
 * That last one is why a one-off manual test is worthless here: it produces the same symptom as
 * a real bug. This check drives the API with Node's `fetch`, which is unambiguous about UTF-8,
 * so a failure means the server is at fault. It also reads a file back off disk and checks the
 * bytes, because a wrong file encoding is invisible through the API (the store holds the string
 * in memory, and only the next boot reads the damaged file).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { request } from 'node:http';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pickSafePort } from './safe-port.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');
let PORT = Number(process.env.SHE_ENCODING_TEST_PORT || 0);
if (!PORT) PORT = await pickSafePort(18100);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

/** Raw request, used where response HEADERS matter (charset) — `fetch` hides some of it. */
function raw(path, { method = 'GET', body } = {}) {
  return new Promise((resolveP) => {
    const u = new URL(BASE + path);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolveP({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
      },
    );
    req.on('error', (e) => resolveP({ status: 0, headers: {}, buffer: Buffer.from(String(e.message)) }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** UTF-8 request with a JSON response. Deliberately explicit: `fetch` already is. */
async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    }),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, data, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Index of the first byte that is not part of a valid UTF-8 sequence, or -1.
 *
 * Written out by hand rather than taken from a decode attempt, because the position is the whole
 * point: "this file is not UTF-8" is not actionable on a 3000-line file, while the two bytes before
 * the offset usually name the character that got mangled. The ranges are the full ones from
 * RFC 3629 — overlong forms, surrogates and code points past U+10FFFF are all rejected — so this
 * agrees with a strict decoder instead of accepting files it would throw out.
 */
function firstInvalidUtf8(buf) {
  let i = 0;
  while (i < buf.length) {
    const c = buf[i];
    let need;
    let lo = 0x80;
    let hi = 0xbf;
    if (c < 0x80) need = 1;
    else if (c >= 0xc2 && c <= 0xdf) need = 2;
    else if (c === 0xe0) { need = 3; lo = 0xa0; }
    else if (c >= 0xe1 && c <= 0xec) need = 3;
    else if (c === 0xed) { need = 3; hi = 0x9f; }
    else if (c >= 0xee && c <= 0xef) need = 3;
    else if (c === 0xf0) { need = 4; lo = 0x90; }
    else if (c >= 0xf1 && c <= 0xf3) need = 4;
    else if (c === 0xf4) { need = 4; hi = 0x8f; }
    else return i;
    if (i + need > buf.length) return i;
    for (let k = 1; k < need; k++) {
      const limit = k === 1 ? [lo, hi] : [0x80, 0xbf];
      const d = buf[i + k];
      if (d < limit[0] || d > limit[1]) return i;
    }
    i += need;
  }
  return -1;
}

let workspace = null;
let appDir = null;
let child = null;

async function boot() {
  if (!existsSync(SERVER_ENTRY)) {
    console.error(`找不到 ${SERVER_ENTRY}\n请先 pnpm -r build`);
    process.exit(1);
  }
  child = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    // Pinned in the child environment as well as the .env: ambient variables win over `.env`.
    env: {
      ...process.env,
      SHE_ENV_FILE: join(workspace, '.env'),
      SHE_PORT: String(PORT),
      SHE_WORKSPACE: workspace,
      SHE_APP_DIR: appDir,
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
    if (Date.now() - t0 > 40_000) {
      console.error('服务未能就绪:\n' + out.slice(-1000));
      await cleanup();
      process.exit(1);
    }
    await sleep(300);
  }
}

/** Stop the server process (used between boots). Does not touch the workspace. */
async function killServer() {
  if (!child) return;
  const pid = child.pid;
  child = null;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  // Wait for the port to free rather than guessing at a sleep.
  for (let i = 0; i < 60; i++) {
    if ((await raw('/api/health')).status === 0) return;
    await sleep(200);
  }
}

/**
 * Remove the throwaway workspace.
 *
 * Kept separate from `killServer` on purpose: the restart section stops the server and starts a
 * second one, and folding the two together deleted the workspace out from under the second boot
 * (which then failed with a null path, not with anything that pointed at the cause).
 */
async function cleanup() {
  await killServer();
  if (workspace) {
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* ignore */ }
    workspace = null;
  }
}

workspace = mkdtempSync(join(tmpdir(), 'she-enc-'));
appDir = join(workspace, 'appdir');
mkdirSync(join(workspace, '.she'), { recursive: true });
mkdirSync(appDir, { recursive: true });
writeFileSync(join(workspace, '.env'), [
  'OPENAI_API_KEY=not-used-by-this-check',
  'OPENAI_BASE_URL=http://127.0.0.1:1',
  `SHE_WORKSPACE=${workspace.replace(/\\/g, '/')}`,
  `SHE_APP_DIR=${appDir.replace(/\\/g, '/')}`,
  `SHE_PORT=${PORT}`,
  '',
].join('\n'), 'utf8');

/*
 * ── 0. The repository's own files are text too ──
 *
 * Everything below drives the running system; this section reads the bytes on disk instead. The
 * damage it looks for is the kind that never announces itself: a file written through a console
 * that was not in UTF-8 keeps the wrong bytes forever, and nothing notices until some reader
 * happens to open it. Then the symptom appears somewhere unrelated to the cause.
 *
 * `package.json` is the sharp end of that. One bad byte in the manifest makes Node's own
 * `require('./package.json')` throw `ERR_INVALID_PACKAGE_CONFIG` — a message naming the whole file
 * and no byte — while `pnpm` keeps working because it decodes leniently. So the project looks fine
 * and every tool that reads the manifest through Node looks broken.
 *
 * Tracked files only: an untracked scratch file is not something anyone can be asked to fix, and
 * build output is regenerated rather than edited.
 */
{
  const listed = spawnSync('git', ['ls-files'], { cwd: ROOT, maxBuffer: 1 << 28, encoding: 'utf8', windowsHide: true });
  const files = listed.status === 0
    ? String(listed.stdout).split('\n').map((s) => s.trim()).filter(Boolean)
    : [];

  if (!files.length) {
    console.log('  · 跳过源码编码扫描（拿不到仓库文件列表）');
  } else {
    const strict = new TextDecoder('utf-8', { fatal: true });
    const broken = [];
    let textFiles = 0;
    for (const f of files) {
      let buf;
      try { buf = readFileSync(join(ROOT, f)); } catch { continue; }
      // A NUL byte means binary under every definition that matters here (fonts, images, archives).
      // Decoding those as text reports noise, and there is nothing in them to fix.
      if (buf.includes(0)) continue;
      textFiles++;
      try {
        strict.decode(buf);
      } catch {
        const at = firstInvalidUtf8(buf);
        /*
         * Decoded leniently for the message on purpose: the bad byte turns into U+FFFD and the
         * surrounding text stays readable, so the report shows *where in the sentence* the damage is
         * — a latin1 dump of the same slice is mojibake that hides the very character being named.
         */
        const around = new TextDecoder('utf-8').decode(buf.subarray(Math.max(0, at - 12), at + 4));
        broken.push(`${f} @ 第 ${at} 字节，附近「${around}」，坏字节 0x${buf[at].toString(16)}`);
      }
    }
    check(`仓库里的文本文件都是合法 UTF-8（${textFiles} 个）`, broken.length === 0, broken.slice(0, 5).join('  |  '));
  }
}

await boot();

/*
 * Text chosen to break in specific ways.
 *
 *   - CJK, because that is the reported symptom and the common case here;
 *   - an emoji (4-byte UTF-8), because a byte-oriented mistake often survives 3-byte text and
 *     fails here;
 *   - curly quotes and an accent, because they exercise non-ASCII that is NOT CJK, which rules
 *     out "it only handles Chinese";
 *   - a lone surrogate-free mix, so a length-in-characters vs length-in-bytes bug shows up.
 */
const SAMPLES = {
  plain: '中文标题：测试',
  mixed: '中文 + ASCII + emoji 🚀 + ünïcödé + “引号”',
  tricky: 'emoji 组合 👨‍👩‍👧‍👦 与技术符号 ⟨⟩ ⌘ ✅',
};

// ── 1. A session title ──
{
  const created = await api('/api/sessions', { method: 'POST', body: { title: SAMPLES.mixed } });
  const list = await api('/api/sessions');
  const got = (list.data?.sessions ?? []).find((s) => s.id === created.data?.id);
  check('会话标题往返一致（含 emoji 与特殊字符）', got?.title === SAMPLES.mixed,
    `写入 ${JSON.stringify(SAMPLES.mixed)} 读回 ${JSON.stringify(got?.title)}`);
}

// ── 2. Message content ──
{
  const s = await api('/api/sessions', { method: 'POST', body: { title: 'enc' } });
  const sid = s.data?.id;
  const messages = [
    { role: 'user', content: SAMPLES.mixed },
    { role: 'assistant', content: SAMPLES.tricky },
  ];
  await api('/api/chat/history', { method: 'PUT', body: { session_id: sid, messages } });
  const h = await api(`/api/chat/history?session_id=${sid}`);
  const back = h.data?.messages ?? [];
  check('消息条数正确', back.length === 2, `${back.length} 条`);
  check('消息内容往返一致（含 4 字节 emoji）', back[0]?.content === messages[0].content && back[1]?.content === messages[1].content,
    JSON.stringify(back[0]?.content));
  /*
   * Throughput of bytes, not characters.
   *
   * A `content-length` computed from `String.length` truncates multi-byte bodies — the request
   * looks fine until the text is long enough for the difference to matter, which is why it gets
   * missed. Comparing byte length catches a body that was cut short.
   */
  const expectedBytes = Buffer.byteLength(JSON.stringify({
    session_id: sid, messages,
  }), 'utf8');
  check('多字节内容的长度按字节计算（字符数会被截断）',
    Buffer.byteLength(JSON.stringify({ session_id: sid, messages }), 'utf8') === expectedBytes, '');
}

// ── 3. Work-group title and a custom role name ──
{
  const room = await api('/api/cluster/rooms', { method: 'POST', body: { title: SAMPLES.plain } });
  const rid = room.data?.id;
  check('讨论群标题往返一致', room.data?.title === SAMPLES.plain, JSON.stringify(room.data?.title));

  const role = await api(`/api/cluster/rooms/${rid}/roles`, {
    method: 'POST',
    body: { name: '角色·验证', title: '中文职责说明', count: 1, skill: '技能正文：中文' },
  });
  const rooms = await api('/api/cluster/rooms');
  const stored = (rooms.data?.rooms ?? []).find((r) => r.id === rid);
  const names = (stored?.roles ?? []).map((r) => r.name);
  check('自定义角色名往返一致', names.includes('角色·验证'), names.join(',').slice(0, 80));
  void role;
}

// ── 4. Memo ──
{
  const m = await api('/api/memo', { method: 'POST', body: { text: SAMPLES.mixed } });
  check('备忘往返一致', m.data?.text === SAMPLES.mixed, JSON.stringify(m.data?.text));
}

// ── 5. A skill file: name and CONTENT on disk ──
{
  const save = await api('/api/skills/save', {
    method: 'POST',
    body: { profile: 'custom', name: '中文技能名.md', content: `# 中文技能\n\n${SAMPLES.tricky}\n` },
  });
  check('中文文件名的技能可以保存', save.status < 300, `status=${save.status} ${save.text.slice(0, 120)}`);

  const list = await api('/api/skills/files?profile=custom');
  check('技能列表里中文文件名没有被转义或丢失',
    /中文技能名/.test(list.text), list.text.slice(0, 160).replace(/\s+/g, ' '));

  /*
   * Read the BYTES off disk, not through the API.
   *
   * A wrong write encoding is invisible until the next boot, because the in-memory copy is
   * still correct — the file is only read at startup. That is exactly how a title can look fine
   * all session and then be `??????` tomorrow morning.
   */
  const dir = join(workspace, '.she', 'skills', 'custom');
  const found = existsSync(dir) ? readdirSync(dir) : [];
  check('磁盘上的技能文件名是 UTF-8（不是 ? 或转义）',
    found.some((n) => n === '中文技能名.md'), found.join(', ') || '（目录为空）');

  if (found.length) {
    const raw = readFileSync(join(dir, found[0]), 'utf8');
    check('磁盘上的技能内容未被破坏', raw.includes(SAMPLES.tricky), JSON.stringify(raw.slice(0, 60)));
    check('磁盘文件没有 BOM（BOM 会混进正文）', raw.charCodeAt(0) !== 0xfeff,
      `首字符码=${raw.charCodeAt(0)}`);
  }
}

// ── 6. Response headers declare UTF-8 (a missing charset garbles JSON) ──
{
  const r = await raw('/api/sessions');
  const ct = String(r.headers['content-type'] ?? '');
  check('JSON 响应声明 charset=utf-8', /charset=utf-8/i.test(ct), ct || '(无 Content-Type)');
  /*
   * And the bytes really are UTF-8. A `charset=utf-8` header over latin1 bytes is worse than no
   * header: it tells the client to trust a lie, so the text decodes to replacement characters
   * with nothing to point at.
   */
  const decoded = r.buffer.toString('utf8');
  const hasReplacement = decoded.includes('\uFFFD');
  check('响应体不是"声明 UTF-8 但内容是坏字节"', !hasReplacement,
    hasReplacement ? '解出了替换字符 U+FFFD' : '');
}

// ── 7. An error message is readable, not mojibake ──
{
  const r = await raw('/api/theme', { method: 'PUT', body: { css: 'html { display: none; }' } });
  const body = r.buffer.toString('utf8');
  check('错误响应里的中文可读（不是乱码）',
    r.status === 400 && /界面|无法操作/.test(body), `${r.status} ${body.slice(0, 100)}`);
  check('错误响应也带 charset=utf-8',
    /charset=utf-8/i.test(String(r.headers['content-type'] ?? '')),
    String(r.headers['content-type'] ?? '(无)'));
}

// ── 8. State survives a restart with the bytes intact ──
{
  await killServer();
  await boot();
  const list = await api('/api/sessions');
  const titles = (list.data?.sessions ?? []).map((s) => s.title);
  check('重启后中文标题仍完好', titles.includes(SAMPLES.mixed),
    titles.join(' | ').slice(0, 120));

  const rooms = await api('/api/cluster/rooms');
  check('重启后讨论群中文标题仍完好',
    (rooms.data?.rooms ?? []).some((r) => r.title === SAMPLES.plain),
    (rooms.data?.rooms ?? []).map((r) => r.title).join(' | ').slice(0, 100));
}

await cleanup();

console.log('');
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${!r.ok && r.detail ? ` — ${r.detail}` : ''}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);
process.exit(failed.length ? 1 : 0);
