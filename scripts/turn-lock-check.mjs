/**
 * One turn at a time per conversation, over HTTP.
 *
 * The agent-level guard is unit-tested, but what a *client* sees is the status code,
 * and that depends on the server mapping the conflict to 409 before it starts
 * streaming. Getting that wrong means a second window sees "Internal Server Error"
 * (or a mid-stream error event) instead of something it can act on.
 *
 * The model endpoint is a LOCAL STUB that delays its reply, so the second request
 * reliably lands while the first is in flight. That makes the test deterministic and
 * costs nothing — no API key needed.
 *
 *   node scripts/turn-lock-check.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');
const PORT = await pickSafePort(Number(process.env.SHE_LOCK_TEST_PORT || 18080), [18081,18082,18083,19090,19191]);

if (!existsSync(SERVER_ENTRY)) {
  console.error(`找不到 ${SERVER_ENTRY}\n请先 pnpm -r build`);
  process.exit(1);
}

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `predicate` is true, or give up.
 *
 * Used instead of fixed sleeps for anything that has to be synchronised with another
 * process: a fixed delay encodes an assumption about how fast the machine is, and that
 * assumption is exactly what fails when the suite runs under load.
 */
async function waitFor(predicate, timeoutMs = 8000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await sleep(stepMs);
  }
}

/* ─── A stub model endpoint that holds each reply open for a moment ─── */
let stubRequests = 0;
const stub = createServer((req, res) => {
  stubRequests++;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let wantsStream = false;
    try {
      wantsStream = JSON.parse(Buffer.concat(chunks).toString('utf8')).stream === true;
    } catch { /* treat as non-streaming */ }

    // Long enough that a second client request certainly overlaps the first.
    setTimeout(() => {
      if (wantsStream) {
        /*
         * Must emit real SSE. A stub that answers a streaming request with plain JSON
         * exercises a different (and misleading) path: the provider sees no frames and
         * reports a broken stream, which looks like a product bug but is the stub's.
         */
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'stub ' } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'reply' }, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'stub reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    // Long enough that the in-flight window is generous even on a loaded machine. A
    // short delay makes the test pass only when the machine is idle, which is the
    // opposite of a reliable check.
    }, 2500);
  });
});

let modelBase = '';
let child = null;
/** Reads the booted server's accumulated output, for diagnostics on failure. */
let onOutput = () => '';
const workspace = mkdtempSync(join(tmpdir(), 'she-lock-'));
mkdirSync(join(workspace, '.she'), { recursive: true });

async function boot() {
  writeFileSync(join(workspace, '.env'), [
    'OPENAI_API_KEY=stub-key',
    `OPENAI_BASE_URL=${modelBase}`,
    'OPENAI_MODEL=stub-model',
    `SHE_WORKSPACE=${workspace.replace(/\\/g, '/')}`,
    `SHE_PORT=${PORT}`,
    // Fast, deterministic: the retry layer is exercised elsewhere.
    'SHE_LLM_ATTEMPTS=1',
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
  // Exposed so a failing assertion can show the server's own output, which is the
  // only way to tell a 500 from a startup problem.
  onOutput = () => out;

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
    await sleep(300);
  }
}

async function shutdown() {
  if (!child) return;
  child.kill();
  child = null;
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(400) });
    } catch {
      return;
    }
    await sleep(200);
  }
}

/** POST a chat turn; returns `{ status }` without waiting for the body to be useful. */
async function sendChat(sessionId, message) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, stream: false, session_id: sessionId }),
    signal: AbortSignal.timeout(20_000),
  });
  let body = null;
  try { body = await r.json(); } catch { /* no body */ }
  return { status: r.status, body };
}

console.log('\n会话级轮次锁检查（本地桩模型，不调用外部 API）\n');

try {
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  modelBase = `http://127.0.0.1:${(stub.address() ).port}`;

  if (!await boot()) throw new Error('启动失败');

  // A session to work in.
  const created = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'lock-test' }),
  }).then((r) => r.json());
  const sid = created.id;
  check('可以创建会话', typeof sid === 'string' && sid.length > 0, JSON.stringify(created));

  // ── Two turns at once on the same conversation ──
  stubRequests = 0;
  const first = sendChat(sid, '第一轮（慢）');
  /*
   * Wait until the first turn is ACTUALLY in flight, rather than sleeping a fixed
   * amount.
   *
   * `sleep(250)` was a guess at how long the request takes to reach the model, and it
   * stopped being true when the machine was busy — under load the second request arrived
   * after the first turn had already finished, so it was correctly accepted and the
   * test failed. A timing-dependent check that fails at random is worse than no check:
   * it trains people to re-run until green.
   *
   * Polling the stub's own counter is the actual precondition: once the model has been
   * called, the server is inside the turn.
   */
  if (!await waitFor(() => stubRequests >= 1, 8000)) {
    check('第一个请求确实进入了模型调用', false, `stubRequests=${stubRequests}`);
  }
  const second = await sendChat(sid, '第二轮（不该被受理）');

  check(
    '第二个请求被拒绝，状态码是 409（不是 500）',
    second.status === 409,
    `status=${second.status} body=${JSON.stringify(second.body)}`,
  );
  check(
    '拒绝理由说明了该怎么做',
    /进行中|interject|追加/.test(JSON.stringify(second.body ?? {})),
    JSON.stringify(second.body),
  );

  const firstResult = await first;
  if (firstResult.status !== 200) {
    // A 500 here means the guard let the turn through but the turn itself failed, so
    // the server's own output is what identifies the cause.
    console.log('        --- 服务器输出（末尾）---');
    for (const l of onOutput().split('\n').slice(-20)) console.log(`        ${l}`);
    const crash = join(workspace, '.she', 'crash.log');
    if (existsSync(crash)) {
      console.log('        --- crash.log ---');
      for (const l of readFileSync(crash, 'utf8').split('\n').slice(-12)) console.log(`        ${l}`);
    }
  }
  check('第一个请求正常完成', firstResult.status === 200, `status=${firstResult.status} body=${JSON.stringify(firstResult.body)}`);
  check('桩模型只收到了一次调用（第二个没有漏到模型）', stubRequests === 1, `stub 收到 ${stubRequests} 次`);

  // ── After the turn ends, the conversation accepts input again ──
  const after = await sendChat(sid, '第三轮（应当可以）');
  check('上一轮结束后可以继续发', after.status === 200, `status=${after.status} body=${JSON.stringify(after.body)}`);
  check('桩模型收到了第二次调用', stubRequests === 2, `stub 收到 ${stubRequests} 次`);

  // ── A different session is NOT blocked by the first ──
  const other = await fetch(`http://127.0.0.1:${PORT}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'other' }),
  }).then((r) => r.json());

  const slowBaseline = stubRequests;
  const slow = sendChat(sid, '慢的一轮');
  // Wait for the turn to be in flight, rather than assuming 250ms is enough.
  if (!await waitFor(() => stubRequests > slowBaseline)) {
    check('并发测试的前一轮进入了模型调用', false, `stubRequests=${stubRequests}`);
  }
  const parallel = await sendChat(other.id, '另一个会话，应当立刻受理');
  check('不同会话之间互不影响（锁是会话级的）', parallel.status === 200, `status=${parallel.status}`);
  await slow;

  // ── Streaming path: also a status code, not a mid-stream error ──
  const streamBaseline = stubRequests;
  const streaming = sendChat(sid, '流式的一轮（慢）');
  if (!await waitFor(() => stubRequests > streamBaseline)) {
    check('流式测试的前一轮进入了模型调用', false, `stubRequests=${stubRequests}`);
  }
  const streamSecond = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message: '流式第二轮', stream: true, session_id: sid }),
    signal: AbortSignal.timeout(10_000),
  }).then((r) => ({ status: r.status, text: r.text() }));

  check(
    '流式请求在开始前就被拒绝（不是流中途报错）',
    streamSecond.status === 409,
    `status=${streamSecond.status}`,
  );
  await streaming;

  // ── Malformed input still behaves ──
  const bad = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 42, session_id: sid }),
  });
  check('非法 message 仍返回 400（没有因为新检查变成别的码）', bad.status === 400, `status=${bad.status}`);
} catch (err) {
  check('检查过程未抛异常', false, err.stack ?? err.message);
} finally {
  await shutdown();
  await new Promise((r) => stub.close(() => r()));
  removeTempDir(workspace);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
