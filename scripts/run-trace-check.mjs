/**
 * Run traces: what a turn actually did, readable afterwards — offline, no API calls.
 *
 * The other stores in `.she/` answer questions about STATE. None of them can answer "in what order
 * did it do things, and did each step work", because:
 *
 *   - the transcript holds messages, not steps;
 *   - the streamed chunks were a UI protocol and are gone when the tab reloads;
 *   - the metrics are counters, so they cannot say which command produced which output.
 *
 * `RunTraceStore` exists only for that question, which makes a small set of properties
 * load-bearing — and each of them fails SILENTLY, which is why they are asserted here:
 *
 *   1. **A run can be re-read and folded into a summary that agrees with its events.** A trace you
 *      cannot summarise is a pile of JSONL, and a summary that disagrees with the events is worse
 *      than none — the panel would show a green run that failed.
 *   2. **A run that DIED is still readable, and its damage is reported.** A half-written line is
 *      counted, never quietly dropped; returning fewer steps looks exactly like a quiet turn.
 *   3. **A credential is not copied into the workspace.** Tool arguments are the common place for
 *      an API key, and this is a second copy on disk — nested, not just at the top level.
 *   4. **A claim about evidence can be CHECKED.** This is the bridge to the delivery template: a
 *      report is required to name its evidence, and now that runs are on disk, "shell: …" can be
 *      refused when this conversation never ran `shell`. An invented citation is the failure mode.
 *
 * It also drives the REAL server, because some properties only exist at the junction: the read
 * routes must serve what the recorder writes, and they must be read-only.
 *
 *   node scripts/run-trace-check.mjs
 */
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';
import { killTree } from './lib/kill-tree.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const AGENT_DIR = join(ROOT, 'packages', 'agent-runtime');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');
const RUNTRACE_MODULE = join(AGENT_DIR, 'dist', 'run-trace.js');

if (!existsSync(SERVER_ENTRY) || !existsSync(RUNTRACE_MODULE)) {
  console.error(`找不到 ${SERVER_ENTRY} 或 ${RUNTRACE_MODULE}\n请先 pnpm -r build`);
  process.exit(1);
}

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 700)}`);
  }
};

const { RunTraceStore, distinctTokens } = await import(pathToFileURL(RUNTRACE_MODULE).href);

/*
 * 每个 store 都属于一个会话 —— 构造时不给会话 id 就抛错，这是"轨迹不可能跨会话"的落点。
 * 用同一个假 id，路径断言才写得清楚；`runsDirOf` 把路径写死（不问实现自己把文件放哪了，
 * 问出来的答案永远"对"）。
 */
const SESSION = 'sess-a';
const storeOn = (root, opts) => new RunTraceStore(root, SESSION, opts);
const runsDirOf = (root, session = SESSION) => join(root, '.she', 'sessions', session, 'runs');
const filesOf = (root, session = SESSION) => readdirSync(runsDirOf(root, session)).filter((f) => f.endsWith('.jsonl')).sort();
const tempDir = (p) => mkdtempSync(join(tmpdir(), p));

/* ══════════════════════════════════════════════════════════════════════════
 * 1. The record: one file per run, readable later, folded into a summary
 * ══════════════════════════════════════════════════════════════════════════ */

const dir = tempDir('she-runs-');

console.log('\n1. 一轮一个文件，写完还能再读出来');
{
  const store = storeOn(dir);
  const rec = store.begin({
    prompt: '跑一遍测试然后汇报',
    sessionId: 'sess-a',
    model: 'test-model',
    tools: ['shell', 'fs_read', 'fs_write'],
    mode: 'manual',
  });
  rec.tool({ name: 'shell', args: '{"cmd":"pnpm test"}', result: 'exit code: 0', ms: 1200, ok: true });
  rec.step('准备收尾');
  rec.end({ ok: true, durationMs: 3000, usage: { total_tokens: 42 } });

  check('写了一个文件', filesOf(dir).length === 1, filesOf(dir).join(', '));
  const id = store.list()[0].id;
  const read = store.read(id);
  check('按 id 能整份读回来', Boolean(read), id);
  check('事件顺序就是发生的顺序',
    read.events.map((e) => e.kind).join(',') === 'start,tool,step,end',
    read.events.map((e) => e.kind).join(','));
  check('seq 从 1 连续编号（读的人可以按号数）',
    read.events.every((e, i) => e.seq === i + 1),
    read.events.map((e) => e.seq).join(','));
  check('没有损坏行', read.skipped === 0, `skipped=${read.skipped}`);

  const run = read.run;
  check('折出来的摘要说这一轮完成了', run.state === 'done', run.state);
  check('摘要里的工具次数与事件一致',
    run.toolCount === 1 && run.failedTools === 0, JSON.stringify(run));
  check('摘要记下了用到的工具名', (run.toolNames ?? []).join(',') === 'shell', (run.toolNames ?? []).join(','));
  check('摘要带上模型和会话', run.model === 'test-model' && run.session_id === 'sess-a', JSON.stringify(run));
  check('摘要带上提问原文', run.prompt === '跑一遍测试然后汇报', run.prompt);
  check('摘要带上耗时与 token', run.durationMs === 3000, String(run.durationMs));

  /*
   * The file is JSONL a human may open. A pretty-printed JSON array would not be appendable, and an
   * unterminated last line would glue onto the next append.
   */
  const raw = readFileSync(join(runsDirOf(dir), `${id}.jsonl`), 'utf8');
  check('是逐行 JSON，且以换行结束（追加安全）', raw.endsWith('\n') && raw.trim().split('\n').every((l) => {
    try { JSON.parse(l); return true; } catch { return false; }
  }), raw.split('\n')[0]?.slice(0, 120));
}

console.log('\n2. 失败、停在人工确认、被中断——三种结局分得清');
{
  const root = tempDir('she-runs-state-');
  const store = storeOn(root);

  const failed = store.begin({ prompt: '连不上的接口' });
  failed.error('connect ECONNREFUSED');
  failed.end({ ok: false, reason: 'turn_failed', text: 'connect ECONNREFUSED' });
  const failedRun = store.list({ limit: 10 }).find((r) => r.id === failed.id);
  check('失败的一轮折成 failed，并带上原因',
    failedRun.state === 'failed' && /ECONNREFUSED/.test(failedRun.error ?? ''),
    JSON.stringify(failedRun));

  /*
   * A run stopped at a confirmation gate is NOT a failure and NOT finished. It has no `end` event
   * at all: the continuation appends to the same file. Getting this wrong makes the most
   * interesting run — the one a person had to approve — read as either complete or broken.
   */
  const paused = store.begin({ prompt: '删掉一个目录' });
  paused.tool({ name: 'shell', result: '{"needs_confirm":{"ticket_id":"tk-1"}}', ok: true });
  paused.awaiting('confirm', { ticketId: 'tk-1', tool: 'shell', summary: 'rm -rf build' });
  const pausedRun = store.list({ limit: 10 }).find((r) => r.id === paused.id);
  check('停在等确认的一轮折成 paused', pausedRun.state === 'paused', JSON.stringify(pausedRun));
  check('paused 的理由是 awaiting_confirm', pausedRun.reason === 'awaiting_confirm', pausedRun.reason);
  check('paused 的轨迹里写明工单和工具',
    store.read(paused.id).events.some((e) => e.kind === 'confirm' && e.ticket_id === 'tk-1' && e.tool === 'shell'),
    null);

  const stopped = store.begin({ prompt: '会被中断的一轮' });
  stopped.tool({ name: 'shell', result: 'ok', ok: true });
  stopped.end({ ok: false, reason: 'aborted' });
  const stoppedRun = store.list({ limit: 10 }).find((r) => r.id === stopped.id);
  check('被用户中断的一轮记下 aborted（不是"出错"）',
    stoppedRun.state === 'failed' && stoppedRun.reason === 'aborted', JSON.stringify(stoppedRun));

  removeTempDir(root);
}

console.log('\n3. 凭据不会在轨迹文件里留下第二份');
{
  const root = tempDir('she-runs-secret-');
  const store = storeOn(root);
  const rec = store.begin({ prompt: '带令牌调用' });
  rec.tool({
    name: 'http',
    args: JSON.stringify({
      url: 'https://api.example.com/v1',
      headers: { Authorization: 'Bearer sk-top-secret', 'x-api-key': 'key-abcdef' },
      env: [{ name: 'DB_PASSWORD', value: 'hunter2' }],
      body: 'token=inline-secret',
    }),
    result: 'ok',
    ok: true,
  });
  const raw = readFileSync(rec.path(), 'utf8');
  for (const secret of ['sk-top-secret', 'key-abcdef', 'hunter2', 'inline-secret']) {
    check(`顶层/嵌套的凭据都不落盘：${secret}`, !raw.includes(secret), null);
  }
  const ev = store.read(rec.id).events.find((e) => e.kind === 'tool');
  check('键名还在（读的人知道传了什么）',
    ev.args.includes('Authorization') && ev.args.includes('api.example.com'), ev.args);
  check('工单也不会出现在轨迹里（那等于把钥匙抄了一份）', !raw.includes('ticket'), null);

  removeTempDir(root);
}

console.log('\n4. 截断说明、损坏报告、轮转记账');
{
  const root = tempDir('she-runs-trunc-');
  const store = storeOn(root, { maxField: 300 });
  const rec = store.begin({ prompt: 'x'.repeat(900) });
  rec.tool({ name: 'shell', result: 'y'.repeat(900), ok: true });
  rec.end({ ok: true });
  const read = store.read(rec.id);
  const tool = read.events.find((e) => e.kind === 'tool');
  check('超长字段被截断', tool.result.length < 900, `len=${tool.result.length}`);
  check('截断记录了原文长度（截断的记录读不成"很短但完整"）', tool.chars === 900, `chars=${tool.chars}`);
  check('start 的提问也被截断并记录长度',
    read.events[0].text.length <= 400 && read.events[0].chars === 900,
    `len=${read.events[0].text.length} chars=${read.events[0].chars}`);
  removeTempDir(root);

  const badRoot = tempDir('she-runs-bad-');
  const badStore = storeOn(badRoot);
  const bad = badStore.begin({ prompt: '正常一轮' });
  bad.tool({ name: 'shell', result: 'ok', ok: true });
  // Exactly the shape a process killed mid-append leaves behind.
  appendFileSync(bad.path(), '{"seq":99,"ts":"2026-01-01T00:00:00.000Z","ki', 'utf8');
  const badRead = badStore.read(bad.id);
  check('半行被计为 skipped（不是静默丢掉）', badRead.skipped === 1, `skipped=${badRead.skipped}`);
  check('好的事件照常返回', badRead.events.length === 2, String(badRead.events.length));

  // A BOM is what a Windows editor leaves behind; it must not read as a damaged file, because a
  // warning that is always on is a warning nobody reads.
  const bomRoot = tempDir('she-runs-bom-');
  const bomStore = storeOn(bomRoot);
  const bom = bomStore.begin({ prompt: '带 BOM' });
  bom.end({ ok: true });
  writeFileSync(bom.path(), '\uFEFF' + readFileSync(bom.path(), 'utf8'), 'utf8');
  check('BOM 不会让整份轨迹变成"损坏"',
    bomStore.read(bom.id).skipped === 0 && bomStore.read(bom.id).events.length === 2, null);

  removeTempDir(badRoot);
  removeTempDir(bomRoot);

  const capRoot = tempDir('she-runs-cap-');
  const capStore = storeOn(capRoot, { keep: 3 });
  const newest = [];
  for (let i = 0; i < 6; i++) {
    const r = capStore.begin({ prompt: `第 ${i} 轮` });
    r.end({ ok: true });
    newest.push(r.id);
  }
  check('保留份数不超过上限', filesOf(capRoot).length <= 3, `${filesOf(capRoot).length} 个`);
  check('最新的那一轮不会被自己删掉',
    filesOf(capRoot).some((f) => f.startsWith(newest[newest.length - 1])), filesOf(capRoot).join(', '));
  const prunes = capStore.list().flatMap((r) => capStore.read(r.id).events).filter((e) => e.kind === 'prune');
  check('清理被记录在存活的轨迹里（历史不会无声消失）',
    prunes.length > 0 && (prunes[0].runs ?? []).length > 0,
    JSON.stringify(prunes[0] ?? null).slice(0, 200));
  removeTempDir(capRoot);
}

console.log('\n5. 读取的边界：越界 id、空目录、跨会话拿不到');
{
  const root = tempDir('she-runs-safe-');
  const store = storeOn(root);
  store.begin({ prompt: '会话 A' }).end({ ok: true });
  const other = new RunTraceStore(root, 'sess-b');
  other.begin({ prompt: '会话 B' }).end({ ok: true });

  check('不存在的 id 返回 null（不是抛错，也不是别的文件）',
    store.read('run-0000-nope') === null, null);
  check('URL 传来的 id 不能走出目录',
    store.read('../../../etc/passwd') === null && store.read('..\\..\\secret') === null, null);

  /*
   * 这一条以前是"按 session_id 过滤"：两个会话的轨迹在同一个文件里，过滤是唯一的分账手段。
   * 现在断言的是结构：两份文件在两个目录里，而且对方的 id 在本地目录里根本不存在。
   */
  check('两个会话的轨迹在两个目录里',
    store.list().length === 1 && other.list().length === 1
      && store.list()[0].prompt === '会话 A' && other.list()[0].prompt === '会话 B', null);
  check('拿对方的 run id 在自己会话里读 → 找不到（不是读到别人的）',
    store.read(other.list()[0].id) === null && other.read(store.list()[0].id) === null, null);
  check('工作区级 runs 目录彻底不存在了（没有"共用的那份"可退回）',
    !existsSync(join(root, '.she', 'runs')), join(root, '.she', 'runs'));
  check('目录没建过时返回空列表而不是抛错',
    storeOn(join(root, 'never-created')).list().length === 0, null);
  removeTempDir(root);
}

console.log('\n6. 证据核对：说得出"这个会话没跑过 shell"');
{
  const root = tempDir('she-runs-corr-');
  const store = storeOn(root);
  const rec = store.begin({ prompt: '读一个文件' });
  rec.tool({ name: 'fs_read', args: '{"path":"src/fixtures/alpha.ts"}', result: 'export const alpha = 1', ok: true });
  rec.end({ ok: true });

  /*
   * The case that matters: evidence invented wholesale. `shell:` names a tool, so the prefix is
   * read as a claim about which tool produced the evidence — and this conversation never ran one.
   */
  const invented = store.corroborate('shell: pnpm test → 12 passed');
  check('点名了没跑过的工具 → 不认这条证据',
    invented.backed === false && /没有调用过 `shell`/.test(invented.reason), invented.reason);

  const real = store.corroborate('fs_read: fixtures/alpha.ts → 文件读到了');
  check('点名跑过的工具、且内容出现在轨迹里 → 认', real.backed === true, real.reason);

  check('没有任何轨迹的会话 → 不假装有支持',
    new RunTraceStore(root, 'sess-nobody').corroborate('shell: ls').backed === false, null);
  check('没有可核对内容的短句 → 不认（不能因为"没什么好查"就放行）',
    store.corroborate('完成').backed === false, null);

  /*
   * Deliberately lenient in one direction: an honest report that paraphrases must not be blocked.
   * So `corroborate` is about catching INVENTION, and the caller acts on "nothing is backed".
   */
  check('核对是"找得到就算支持"，不核对措辞是否逐字一致',
    store.corroborate('fs_read: 读了 alpha.ts 相关的东西').backed === true, null);

  /*
   * 跨会话的证据在这里只有一个结果：不认。不是因为它"识别出"那是别人的轨迹，而是因为本会话目录里
   * 没有它 —— 识别是一次判断，路径不存在才是保证。两个会话都写、只有一个能认，差别才确实来自目录。
   */
  const other = new RunTraceStore(root, 'sess-other');
  other.begin({ prompt: '另一个会话跑过 shell' }).end({ ok: true });
  const r2 = other.begin({ prompt: '另一个会话的第二步' });
  r2.tool({ name: 'shell', args: '{"cmd":"pnpm test"}', result: 'exit code: 0', ok: true });
  r2.end({ ok: true });
  check('另一个会话跑过 shell，也不改变本会话的核对结果',
    store.corroborate('shell: pnpm test → 12 passed').backed === false
      && other.corroborate('shell: pnpm test → 12 passed').backed === true, null);

  const toks = distinctTokens('exit code: 0, tests passed for fixtures/alpha.test.ts');
  check('常见词不进候选（否则核对形同虚设）',
    !toks.includes('exit') && !toks.includes('code') && !toks.includes('tests'), toks.join(','));
  check('路径这种可指认的串会进候选', toks.includes('fixtures/alpha.test.ts'), toks.join(','));

  removeTempDir(root);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. The junctions: what the real server serves, and that it is read-only
 * ══════════════════════════════════════════════════════════════════════════ */

const PORT = String(await pickSafePort(Number(process.env.SHE_RUNTRACE_TEST_PORT || 18161), [18162, 18163, 18164, 19191]));
const workspace = tempDir('she-runs-live-');

const child = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: workspace,
    SHE_PORT: PORT,
    SHE_APP_DIR: join(workspace, 'appdir'),
    SHE_STATE_DIR: workspace,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serverOut = '';
child.stdout.on('data', (c) => { serverOut += c; });
child.stderr.on('data', (c) => { serverOut += c; });

async function waitForHealth(timeoutMs = 30_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

const api = (path, init) => fetch(`http://127.0.0.1:${PORT}${path}`, { signal: AbortSignal.timeout(8000), ...init });
const post = (path, body) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function cleanup() {
  killTree(child.pid);
  removeTempDir(workspace);
}

console.log('\n7. /api/runs：读到的就是 recorder 写下的');
if (!(await waitForHealth())) {
  console.log('  FAIL  服务在 30 秒内就绪');
  console.log(`        ${serverOut.slice(-800)}`);
  cleanup();
  removeTempDir(dir);
  console.log('\nFAIL (1)  run-trace-check');
  process.exit(1);
}

try {
  const emptyRes = await api('/api/runs');
  check('GET /api/runs 返回 200', emptyRes.status === 200, `status=${emptyRes.status}`);
  const empty = await emptyRes.json();
  check('空工作区返回空列表（不是报错，也不是伪造一条）',
    Array.isArray(empty.runs) && empty.runs.length === 0, JSON.stringify(empty).slice(0, 200));
  check('带上目录与计数，界面不用再发一次请求',
    typeof empty.root === 'string' && typeof empty.total === 'number'
      && typeof empty.paused === 'number' && typeof empty.failed === 'number',
    JSON.stringify(empty).slice(0, 240));

  /*
   * Write with the real recorder and read over HTTP. This is the assertion that the two halves
   * agree on a FORMAT — the server reads the file the recorder writes, not a shape of its own
   * invention that happens to look similar.
   *
   * `sess-live` is used everywhere below, and it has to be: the runs live in that conversation's
   * directory, so a request without a session id is a request about whatever conversation the
   * server considers active — which is a different question.
   */
  const writer = new RunTraceStore(workspace, 'sess-live');
  const live = writer.begin({ prompt: '线上写一轮', model: 'm-live' });
  live.tool({ name: 'shell', args: '{"cmd":"echo hi"}', result: 'hi', ms: 5, ok: true });
  live.tool({ name: 'shell', args: '{"cmd":"exit 1"}', result: 'exit code: 1', ms: 7, ok: false, failure: 'nonzero_exit' });
  live.awaiting('confirm', { ticketId: 'tk-live', tool: 'shell', summary: '要删东西' });

  const listed = await (await api('/api/runs?session_id=sess-live')).json();
  check('服务读得到 recorder 写下的那一轮',
    listed.runs.length === 1 && listed.runs[0].id === live.id,
    JSON.stringify(listed).slice(0, 240));
  check('列表里的状态是"停在等人工"', listed.runs[0].state === 'paused', listed.runs[0].state);
  check('计数把 paused 单独算出来', listed.paused === 1, String(listed.paused));
  check('列表统计了失败的工具次数',
    listed.runs[0].toolCount === 2 && listed.runs[0].failedTools === 1,
    JSON.stringify(listed.runs[0]));

  const one = await (await api(`/api/runs/${live.id}?session_id=sess-live`)).json();
  check('GET /api/runs/:id 返回完整事件序列',
    Array.isArray(one.events) && one.events.map((e) => e.kind).join(',') === 'start,tool,tool,confirm',
    (one.events ?? []).map((e) => e.kind).join(','));
  check('事件里的工具名/参数/结果都读得到',
    one.events[1].tool === 'shell' && one.events[1].args.includes('echo hi') && one.events[1].result === 'hi',
    JSON.stringify(one.events[1] ?? null).slice(0, 240));
  check('失败的分类也跟着读回来（"失败"两个字不够用）',
    one.events[2].ok === false && one.events[2].failure === 'nonzero_exit',
    JSON.stringify(one.events[2] ?? null).slice(0, 240));
  check('损坏行数随详情一起报告', typeof one.skipped === 'number', String(one.skipped));

  check('不存在的 id 是 404（不是空对象）',
    (await api('/api/runs/run-does-not-exist?session_id=sess-live')).status === 404, null);
  check('越界 id 也是 404，不读目录外的文件',
    (await api('/api/runs/..%2F..%2Fsecret?session_id=sess-live')).status === 404, null);

  /*
   * 跨会话：显式点名另一个会话时，本会话的 run id 在那里找不到。这一条是"服务端不会拿一个 id 去
   * 到处猜目录"的钉子 —— 猜是能猜到的，那才是要防的。
   */
  const other = new RunTraceStore(workspace, 'sess-elsewhere');
  other.begin({ prompt: '别的会话跑的一轮' }).end({ ok: true });
  check('拿本会话的 run id 去另一个会话里读 → 404',
    (await api(`/api/runs/${live.id}?session_id=sess-elsewhere`)).status === 404, null);
  check('缺少 session_id 的单轮详情 → 400（不猜一个会话去读）',
    (await api(`/api/runs/${live.id}`)).status === 400, null);

  check('?session_id= 只回该会话的轨迹',
    (await (await api('/api/runs?session_id=sess-live')).json()).runs.length === 1, null);
  check('?session_id= 查不到时返回空，而不是退回全部',
    (await (await api('/api/runs?session_id=nobody')).json()).runs.length === 0, null);
  check('?limit=1 只回一条', (await (await api('/api/runs?limit=1&session_id=sess-live')).json()).runs.length === 1, null);

  /*
   * 跨会话是显式动作：默认（不带参数）只看当前会话，`scope=workspace` 才跨目录读，并且每一行都带
   * 自己所属的会话 id —— 面板要靠它把详情请求发回正确的目录。
   */
  const wide = await (await api('/api/runs?scope=workspace')).json();
  check('scope=workspace 才跨会话，且每行标明属于哪个会话',
    wide.scope === 'workspace' && wide.runs.length === 2
      && wide.runs.every((r) => typeof r.session_id === 'string')
      && wide.runs.map((r) => r.session_id).sort().join(',') === 'sess-elsewhere,sess-live',
    JSON.stringify(wide.runs.map((r) => r.session_id)));
  check('默认不带 scope 时不跨会话（隐私视图是默认的）',
    (await (await api('/api/runs?session_id=sess-live')).json()).scope === 'session', null);

  /*
   * corroborate is a separate route and must be registered BEFORE `/api/runs/:id`, or it is read
   * as a request for a run whose id is "corroborate" — a 404 that hides the real endpoint.
   */
  const corr = await api(`/api/runs/corroborate?session_id=sess-live&evidence=${encodeURIComponent('shell: echo hi')}`);
  check('GET /api/runs/corroborate 不是被当成 id=corroborate（路由顺序对）',
    corr.status === 200, `status=${corr.status}`);
  const corrBody = await corr.json();
  check('跑过的工具 + 出现过的内容 → 认这条证据', corrBody.backed === true, JSON.stringify(corrBody));
  const corrBad = await (await api(`/api/runs/corroborate?session_id=sess-live&evidence=${encodeURIComponent('git: push 成功')}`)).json();
  check('没跑过的工具 → 不认（这正是要拦的"编造证据"）',
    corrBad.backed === false && /git/.test(corrBad.reason), JSON.stringify(corrBad));
  const corrElsewhere = await (await api(`/api/runs/corroborate?session_id=sess-elsewhere&evidence=${encodeURIComponent('shell: echo hi')}`)).json();
  check('同一条证据换一个会话核对 → 不认（它只对本会话的轨迹成立）',
    corrElsewhere.backed === false, JSON.stringify(corrElsewhere));
  check('缺 evidence 返回 400（而不是当成"无证据可查"放行）',
    (await api('/api/runs/corroborate?session_id=sess-live')).status === 400, null);

  /*
   * Damage over HTTP: a half-line must show up as `skipped`, because a count the API never
   * reports is a count the UI cannot warn about.
   */
  appendFileSync(live.path(), '{"seq":99,"ts":"2026-01-01T00:00:00.000Z","ki', 'utf8');
  check('损坏的行通过 skipped 报告出来',
    (await (await api(`/api/runs/${live.id}?session_id=sess-live`)).json()).skipped === 1, null);

  /*
   * Read-only. A trace a client can rewrite is not evidence — the whole reason this store exists.
   */
  const writes = await Promise.all([
    post('/api/runs', {}),
    api('/api/runs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    api('/api/runs', { method: 'DELETE' }),
    api(`/api/runs/${live.id}?session_id=sess-live`, { method: 'DELETE' }),
    post('/api/runs/corroborate', {}),
  ]);
  check('没有写入 / 修改 / 清空轨迹的接口',
    writes.every((r) => r.status === 404 || r.status === 405),
    writes.map((r) => r.status).join(', '));
  check('被拒的写入没有改动文件',
    (await (await api(`/api/runs/${live.id}?session_id=sess-live`)).json()).events.length === 4, null);
} catch (err) {
  check('运行轨迹端点可用', false, err.message);
}

cleanup();
removeTempDir(dir);

/* ══════════════════════════════════════════════════════════════════════════
 * 3. The wiring that cannot be exercised without a model turn
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n8. 接线与只读界面');
{
  const agentSrc = readFileSync(join(AGENT_DIR, 'src', 'agent.ts'), 'utf8');
  const serverSrc = readFileSync(join(SERVER_DIR, 'src', 'index.ts'), 'utf8');
  const uiPath = join(ROOT, 'packages', 'ui', 'src', 'components', 'RunTracePanel.tsx');
  const uiSrc = readFileSync(uiPath, 'utf8');
  const appSrc = readFileSync(join(ROOT, 'packages', 'ui', 'src', 'App.tsx'), 'utf8');

  /*
   * The tool junction only fires during a real turn, and this check has to stay free — so the
   * wiring is asserted structurally. A missing recorder call is a silent hole in the trace, which
   * is the failure this whole file exists to prevent.
   */
  check('每轮开始就开一份轨迹（带上提问、会话、模型、工具清单）',
    /private beginRun\([\s\S]{0,1400}?this\.runTrace\?\.begin\(/.test(agentSrc), null);
  check('工具调用在同一个作用域里记录（名字/参数/结果/耗时/分类都在）',
    /runRecorder\?\.tool\(\{[\s\S]{0,400}?name,\s*args:[\s\S]{0,200}?ms:[\s\S]{0,120}?ok:/.test(agentSrc), null);
  check('等确认时记录，并且那一轮不会就此收尾',
    /runPaused = 'confirm'/.test(agentSrc) && /runRecorder\?\.awaiting\('confirm'/.test(agentSrc), null);
  check('等应用补丁时同样记录', /runRecorder\?\.awaiting\('apply'/.test(agentSrc), null);
  check('人工批准之后真的执行了那一步，也记一笔',
    /confirmToolBody[\s\S]{0,6000}?runRecorder\?\.tool\(/.test(agentSrc), null);
  check('失败的轮次把原因写进轨迹（不是只在对话里说一声）',
    /private failTurn[\s\S]{0,3000}?runRecorder\?\.error\(/.test(agentSrc), null);
  check('被中断 / 卡死循环 / 到上限 / 预算停止都记下理由（四种都不是"失败"）',
    /reason: 'aborted'/.test(agentSrc) && /reason: 'stuck_loop'/.test(agentSrc)
      && /reason: 'max_iterations'/.test(agentSrc) && /reason: 'budget'/.test(agentSrc), null);
  check('停在等人工的轮次不会被当成"跑完了"关掉',
    /private closeRunIfDone[\s\S]{0,200}?runIsPaused\(\)[\s\S]{0,120}?runHeld\(\)/.test(agentSrc)
      && /withTurn[\s\S]{0,4000}?this\.closeRunIfDone\(\)/.test(agentSrc), null);
  check('一次批应用多个补丁时，轨迹不会在第一个之后就断掉',
    /applyAllPatches[\s\S]{0,900}?this\.runHold\+\+/.test(agentSrc), null);
  check('拒绝补丁也记一笔（"这个文件没改，因为人说不"是个决定）',
    /rejectPatch[\s\S]{0,900}?runRecorder\?\.step/.test(agentSrc), null);
  check('续跑（确认/应用）会把 paused 清掉，否则轨迹永远收不了尾',
    (agentSrc.match(/this\.runPaused = null;/g) ?? []).length >= 3, String((agentSrc.match(/this\.runPaused = null;/g) ?? []).length));
  check('状态说明（换备用接口、卡死提示）也进轨迹',
    /type === 'status'[\s\S]{0,200}?runRecorder\?\.step/.test(agentSrc), null);

  /* ── 「在等谁」：暂停的出口 ──
   *
   * 有 `runPaused` 而没有出口时，界面能拿到的只有一张工单；工单的 TTL 一过就点不动了，而这一轮**还停
   * 在那里**。所以这里要证明的不只是"能说出在等人"，而是"过期之后它仍然说自己停着、且不会自行继续"。
   * 判定是纯函数，所以过期这一支是确定地走一遍，不是靠等 120 秒。
   */
  const { describeWaiting } = await import(pathToFileURL(join(AGENT_DIR, 'dist', 'pending-wait.js')).href);
  const liveTicket = {
    tool: 'shell', summary: 'rm -rf build',
    created_at: '2026-10-01T10:00:00.000Z', expires_at: '2026-10-01T10:02:00.000Z',
  };
  const waitingNow = describeWaiting('confirm', liveTicket, Date.parse('2026-10-01T10:01:00.000Z'));
  const waitingExpired = describeWaiting('confirm', liveTicket, Date.parse('2026-10-01T10:05:00.000Z'));
  check('【关键】停着等确认时说得清在等谁、从什么时候起',
    waitingNow?.waitingOn === 'user' && waitingNow?.since === liveTicket.created_at && waitingNow?.expired === false,
    JSON.stringify(waitingNow));
  check('【关键】工单过期之后仍然报"停着等你"，而不是变成"结束了"',
    waitingExpired?.expired === true && waitingExpired?.waitingOn === 'user'
      && /仍然停着/.test(waitingExpired?.note ?? '') && /不会自行批准/.test(waitingExpired?.note ?? ''),
    JSON.stringify(waitingExpired));
  check('没停着时没有可报的等待（光有工单不算在等）',
    describeWaiting(null, liveTicket) === null, null);

  check('agent 把这个状态暴露出来（否则界面只能去猜工单过期意味着什么）',
    /getWaitingOn\(\)\s*:\s*PendingWait \| null[\s\S]{0,220}?describeWaiting\(this\.runPaused/.test(agentSrc), null);
  check('【关键】接口把 waiting 和 ticket 一起回（工单是凭据，waiting 才是"在等谁"）',
    /\/api\/chat\/pending-confirm'[\s\S]{0,900}?getPendingConfirm\(\)[\s\S]{0,200}?getWaitingOn\(\)/.test(serverSrc), null);
  check('【关键】提问那边也用同一套词说"在等谁"（两种等待不该有两套判断）',
    /\/api\/ask\/pending'[\s\S]{0,1200}?waitingOn: 'user'/.test(serverSrc), null);

  check('server 提供 /api/runs 列表', /router\.get\('\/api\/runs'/.test(serverSrc), null);
  check('server 提供单轮详情', /router\.get\('\/api\/runs\/:id'/.test(serverSrc), null);
  check('corroborate 注册在 :id 之前（否则会被当成一个 id）',
    serverSrc.indexOf("'/api/runs/corroborate'") < serverSrc.indexOf("'/api/runs/:id'"), null);
  check('轨迹目录跟着工作区走（换项目不会混在一起）',
    /function runTraceStore[\s\S]{0,500}?config\.workspace\.root/.test(serverSrc), null);
  /*
   * 隔离的接线断言：轨迹的落点必须是"这个会话的目录"，而不是工作区。这一条如果松掉，上面所有关于
   * 两个目录的断言都还在，但真实运行写出来的会是一份共用的 —— 这正是要看住的那种破法。
   */
  check('agent 把轨迹写进本会话自己的目录（无会话就不写）',
    /new RunTraceStore\(config\.workspace\.root, this\.sessionId\)/.test(agentSrc), null);
  check('server 的单轮详情必须带会话，不从 id 猜目录',
    /\/api\/runs\/:id'[\s\S]{0,600}?session_id is required/.test(serverSrc), null);
  check('跨会话查看是显式参数（scope=workspace），默认是隐私视图',
    /scope === 'workspace'/.test(serverSrc) && /scope === 'session' && !sessionId/.test(serverSrc), null);

  check('界面用 GET /api/runs 取列表', /\/api\/runs/.test(uiSrc), null);
  check('界面面板只读：没有 POST / PUT / DELETE 调用',
    !/method:\s*'(POST|PUT|DELETE)'/i.test(uiSrc), null);
  check('界面把损坏行数展示出来（和审计面板一致）', /skipped/.test(uiSrc), null);
  check('界面把"停在等人工"当成一个独立状态显示',
    /paused:/.test(uiSrc) && /等人工/.test(uiSrc), null);
  check('面板默认只看本会话，跨会话要点一下',
    /useState<'session' \| 'workspace'>\('session'\)/.test(uiSrc), null);
  check('详情请求带上该行所属的会话（否则服务端无处去读）',
    /\/api\/runs\/\$\{encodeURIComponent\(selected\)\}\$\{q\}/.test(uiSrc)
      && /find\(\(r\) => r\.id === selected\)\?\.session_id/.test(uiSrc), null);
  check('面板在 App.tsx 里接上了（命令面板能打开）',
    /RunTracePanel/.test(appSrc) && /打开运行轨迹/.test(appSrc), null);
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}  run-trace-check`);
process.exit(failures === 0 ? 0 : 1);
