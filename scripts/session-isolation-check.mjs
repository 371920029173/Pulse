/**
 * 会话隔离：一个会话的私有状态，另一个会话读不到、写不动 —— 离线为主，最后真起一次服务。
 *
 * 为什么单独有这一份：这条性质以前**每一层都各自"做了"**（计划里带 session_id 过滤、备忘里带、轨迹里带），
 * 而它们是各自失败的，失败方式还都一样 —— 静默。文件的路径上没有会话，过滤只是"读的时候比一下"，
 * 于是任何一处忘了带上过滤、或者任何一次直接读文件，隔离就没了，而且从外面看不出来：界面照常显示，
 * 只是显示的是别人的东西。实测就是这样（见 2026-09-27 的专项检查）。
 *
 * 所以这份检查不问"有没有过滤"，问三件别的事：
 *
 *   1. **路径**：五个维度（计划 / 备忘 / 预检 / 轨迹 / 置信度样本）的落点是不是都在
 *      `.she/sessions/<id>/` 下面，两个会话两条不同的路径，且 `.she/` 顶层不再有它们；
 *   2. **读**：A 把五个维度都写满，B 一个字段都读不到 —— 而不是"读到了然后拒绝"；
 *   3. **写**：拿着 A 的 id 从 B 改，改不动，且 A 的文件一个字节都没变。
 *
 * 再加上一层**反向钉子**：工作区顶层不许出现这些文件/目录。回归通常不是"过滤写漏了"，而是"顺手又建了
 * 一份工作区级文件" —— 那一条必须响。
 *
 * 唯一的例外是**跨会话的数字账**（`.she/reflection/confidence.json`），它是刻意共用的：习惯要跨重启才
 * 看得出来，而那里只有数字、没有一个字的话题文本。这份检查把这个例外也钉住：它的收益（B 能读到结论）
 * 和它的边界（话题文本不在里面）都要成立。
 *
 *   node scripts/session-isolation-check.mjs
 */
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pickSafePort } from './safe-port.mjs';
import { removeTempDir } from './lib/temp.mjs';
import { killTree } from './lib/kill-tree.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const AGENT_DIST = join(ROOT, 'packages', 'agent-runtime', 'dist');
const SERVER_DIR = join(ROOT, 'packages', 'server');
const SERVER_ENTRY = join(SERVER_DIR, 'dist', 'index.js');
const RUNTIME_ENTRY = join(AGENT_DIST, 'index.js');
const PREFLIGHT_ENTRY = join(AGENT_DIST, 'preflight.js');

for (const p of [SERVER_ENTRY, RUNTIME_ENTRY, PREFLIGHT_ENTRY]) {
  if (!existsSync(p)) {
    console.error(`找不到 ${p}\n请先 pnpm -r build`);
    process.exit(1);
  }
}

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 700)}`);
  }
};

const samePath = (a, b) => resolve(String(a)).toLowerCase() === resolve(String(b)).toLowerCase();
const tempDir = (p) => mkdtempSync(join(tmpdir(), p));

const { PlanStore, MemoStore, RunTraceStore, ConfidenceMirror } =
  await import(pathToFileURL(RUNTIME_ENTRY).href);
const { PreflightStore } = await import(pathToFileURL(PREFLIGHT_ENTRY).href);

const A = 'sess-alpha';
const B = 'sess-beta';

/** 五个维度的落点 —— 写死的期望值，和实现自己报出来的路径分开比对。 */
const dims = {
  计划: (root, s) => join(root, '.she', 'sessions', s, 'plans.json'),
  备忘: (root, s) => join(root, '.she', 'sessions', s, 'memo.json'),
  预检: (root, s) => join(root, '.she', 'sessions', s, 'preflight'),
  轨迹: (root, s) => join(root, '.she', 'sessions', s, 'runs'),
  样本: (root, s) => join(root, '.she', 'sessions', s, 'confidence.json'),
};

/**
 * 这些 store 实际把文件放哪了。
 *
 * 和 `dims` 是两套：`dims` 是"应该在哪"，这里是"实现说它在哪"。两边一旦分叉，下面所有读/写断言
 * 都会对着空气，而且全是绿的 —— 所以先比这两套。
 *
 * 报法不统一（计划报的是会话目录本身、轨迹报的是 runs 子目录、备忘什么都不报），所以这里返回
 * "它报出来的那个位置"，由调用方对着 `dims` 里对应的那一项做包含判断：文件的那一项要落在它下面。
 */
const reportedDirs = (root, sessionId) => ({
  计划: new PlanStore(root, sessionId).directory,
  轨迹: new RunTraceStore(root, sessionId).directory(),
  // 预检和样本不报路径，只能从它们写出来的东西反推（见本节末尾）。
});

const dir = tempDir('she-isolation-');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 路径：五个维度的落点都带会话 id，两个会话两条不同的路径
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n1. 路径：私有状态落在自己的会话目录里');
{
  const reported = reportedDirs(dir, A);
  for (const [name, where] of Object.entries(reported)) {
    /*
     * 每个 store 报出来的位置含义不一样（计划报会话目录、轨迹报 runs 目录），但要求是同一条：
     * `dims` 里写死的那条路径必须落在它报出来的位置**下面**。报的比期望的大一级没关系（它报的是
     * 目录），报成别的地方就有关系了。
     */
    check(`${name}：写死的那条路径确实在它报出来的目录下`,
      resolve(dims[name](dir, A)).startsWith(resolve(where)), `${dims[name](dir, A)} vs ${where}`);
  }
  for (const name of Object.keys(dims)) {
    check(`${name}：两个会话不是同一条路径`,
      !samePath(dims[name](dir, A), dims[name](dir, B)), dims[name](dir, A));
    check(`${name}：路径确实在工作区里`,
      resolve(dims[name](dir, A)).startsWith(resolve(dir)), dims[name](dir, A));
  }
  /*
   * PreflightStore / ConfidenceMirror 不报路径，只能从它们写出来的文件反推 —— 这两样是"文件真的
   * 落在会话目录里"而不是"getter 说的是"。
   */
  new PreflightStore(dir, A).save({
    id: 'pf-alpha', createdAt: new Date().toISOString(), stated_intent: 'x', inferred_constraints: [],
    prerequisites: [], actual_goal: 'x', clarification_needed: [], known_errors: [], confidence: 0.5,
    confidenceClamped: false, findings: [],
  });
  new ConfidenceMirror(dir, A).observe({ claimed: 0.5, attempted: 1, succeeded: 1, topic: 'x' });
  check('预检文件真的落在会话目录里', existsSync(dims.预检(dir, A)) && readdirSync(dims.预检(dir, A)).length === 1, null);
  check('置信度样本文件真的落在会话目录里', existsSync(dims.样本(dir, A)), null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. A 写满五个维度，B 一个字段都读不到
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n2. 读：A 写满五个维度，B 一个字段都读不到');
let seeded;
{
  const plan = new PlanStore(dir, A).create('把数据从 MySQL 搬到 Postgres', ['导出', '校验', '切流量']);
  const memo = new MemoStore(dir, A).add('迁移期间先停写', 'user');
  const run = new RunTraceStore(dir, A).begin({ prompt: '导出生产库', model: 'm-iso' });
  run.tool({ name: 'shell', args: '{"cmd":"pg_dump"}', result: 'ok', ms: 3, ok: true });
  run.end({ ok: true });
  new ConfidenceMirror(dir, A).observe({ claimed: 0.95, attempted: 4, succeeded: 1, topic: '数据迁移' });
  seeded = { plan, memo, run };

  // A 自己读得到 —— 否则下面"B 读不到"可能只是因为什么都没写进去。
  check('A 读得到自己的计划', new PlanStore(dir, A).list().some((p) => p.title.includes('搬')), null);
  check('A 读得到自己的备忘', new MemoStore(dir, A).list().length === 1, null);
  check('A 读得到自己的预检', new PreflightStore(dir, A).list().length === 1, null);
  check('A 读得到自己的轨迹', new RunTraceStore(dir, A).list().length === 1, null);
  check('A 读得到自己的样本', new ConfidenceMirror(dir, A).samples().length === 2, null);

  check('B 读不到 A 的计划（不是"读到再过滤"）', new PlanStore(dir, B).list().length === 0, null);
  check('B 读不到 A 的备忘', new MemoStore(dir, B).list().length === 0, null);
  check('B 读不到 A 的预检', new PreflightStore(dir, B).list().length === 0, null);
  check('B 读不到 A 的轨迹', new RunTraceStore(dir, B).list().length === 0, null);
  check('B 读不到 A 的样本（话题文本是 A 的）', new ConfidenceMirror(dir, B).samples().length === 0, null);
  check('B 的目录里没有被凭空造出来的文件',
    !existsSync(dims.计划(dir, B)) && !existsSync(dims.备忘(dir, B)) && !existsSync(dims.样本(dir, B)), null);

  /* ══════════════════════════════════════════════════════════════════════
   * 3. 写：拿着 A 的 id 从 B 改，改不动，且 A 的文件没被碰过
   * ══════════════════════════════════════════════════════════════════════ */
  console.log('\n3. 写：从 B 拿着 A 的 id 改，改不动，A 的文件也没被碰');

  const before = {
    plans: readFileSync(dims.计划(dir, A), 'utf8'),
    memo: readFileSync(dims.备忘(dir, A), 'utf8'),
  };
  const refusedPlan = new PlanStore(dir, B).setStepStatus(plan.id, plan.steps[0].id, 'done');
  check('改 A 的步骤：被拒（不是静默改到别处）', refusedPlan.ok === false, JSON.stringify(refusedPlan).slice(0, 200));
  check('拒了之后 B 的文件里没有半截改动', new PlanStore(dir, B).list().length === 0, null);

  const refusedMemo = new MemoStore(dir, B).update(memo.id, { done: true });
  check('改 A 的备忘：返回"没有这条"，不是改到同 id 的别的条目', refusedMemo === undefined, null);
  check('删 A 的备忘也删不掉', new MemoStore(dir, B).remove(memo.id) === false, null);
  check('拿 A 的轨迹 id 从 B 读：读不到', new RunTraceStore(dir, B).read(run.id) == null, null);

  check('A 的计划文件一个字节都没变',
    readFileSync(dims.计划(dir, A), 'utf8') === before.plans, null);
  check('A 的备忘文件一个字节都没变',
    readFileSync(dims.备忘(dir, A), 'utf8') === before.memo, null);

  /* ══════════════════════════════════════════════════════════════════════
   * 4. 唯一的例外：跨会话的数字账（只有数字，没有说话）
   * ══════════════════════════════════════════════════════════════════════ */
  console.log('\n4. 例外：习惯的数字账是共用的，但里面没有一个字的话');

  const bReport = new ConfidenceMirror(dir, B).report();
  check('B 读得到结论（习惯跨会话可见，这是这份例外存在的理由）', bReport.samples === 2, JSON.stringify(bReport));
  const ledgerRaw = readFileSync(join(dir, '.she', 'reflection', 'confidence.json'), 'utf8');
  check('数字账里没有 A 的话题文本', !ledgerRaw.includes('数据迁移'), ledgerRaw.slice(0, 240));
  check('数字账里没有 run id（少一条指回原文的线）', !ledgerRaw.includes(run.id), ledgerRaw.slice(0, 240));
  check('B 的结论里也不点名话题（那是 A 的样本）', bReport.worst.length === 0, JSON.stringify(bReport.worst));

  /* ══════════════════════════════════════════════════════════════════════
   * 5. 反向钉子：工作区顶层不许再出现这五样
   * ══════════════════════════════════════════════════════════════════════ */
  console.log('\n5. 反向钉子：工作区顶层不许再出现这些文件/目录');

  const top = readdirSync(join(dir, '.she'));
  for (const name of ['plans.json', 'memo.json', 'preflight', 'runs']) {
    check(`.she/ 顶层没有 ${name}`, !top.includes(name), top.join(', '));
  }
  check('.she/ 顶层没有一个装所有会话的 confidence.json',
    !top.includes('confidence.json'), top.join(', '));
  check('这五样都只长在会话目录里',
    existsSync(dims.计划(dir, A)) && existsSync(dims.备忘(dir, A))
      && existsSync(dims.预检(dir, A)) && existsSync(dims.轨迹(dir, A)) && existsSync(dims.样本(dir, A)), null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 真起服务：跨会话的读要显式，写要落到点名的那份
 * ══════════════════════════════════════════════════════════════════════════ */

const PORT = String(await pickSafePort(Number(process.env.SHE_ISOLATION_TEST_PORT || 18171), [18172, 18173, 18174, 19192]));
const workspace = tempDir('she-isolation-live-');

// 先在线下把两个会话的状态写好，服务起来就有东西可读。
const seedPlan = new PlanStore(workspace, 'sess-a').create('把网关换成新版本', ['灰度', '全量']);
const seedMemo = new MemoStore(workspace, 'sess-a').add('网关切换前先备份路由表', 'user');
const seedRun = new RunTraceStore(workspace, 'sess-a').begin({ prompt: '切网关', model: 'm-iso' });
seedRun.tool({ name: 'shell', args: '{"cmd":"reload"}', result: 'ok', ms: 2, ok: true });
seedRun.end({ ok: true });
new ConfidenceMirror(workspace, 'sess-a').observe({ claimed: 0.9, attempted: 4, succeeded: 1, topic: '网关切换' });
new PlanStore(workspace, 'sess-b').create('另一件事', ['一步']);

const child = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: workspace,
    SHE_PORT: PORT,
    SHE_ENV_FILE: join(workspace, '.env'),
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
const get = async (path) => {
  const r = await api(path);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const send = (method, path, body) => api(path, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function cleanup() {
  killTree(child.pid);
  removeTempDir(workspace);
}

console.log('\n6. /api：跨会话的读要显式，写落到点名的那份');
if (!(await waitForHealth())) {
  console.log('  FAIL  服务在 30 秒内就绪');
  console.log(`        ${serverOut.slice(-800)}`);
  cleanup();
  removeTempDir(dir);
  console.log('\nFAIL (1)  session-isolation-check');
  process.exit(1);
}

try {
  const aPlans = await get('/api/plans?session_id=sess-a');
  const bPlans = await get('/api/plans?session_id=sess-b');
  check('/api/plans 只回点名那个会话的计划',
    aPlans.body.plans.length === 1 && aPlans.body.plans[0].id === seedPlan.id
      && bPlans.body.plans.length === 1 && bPlans.body.plans[0].title === '另一件事',
    JSON.stringify({ a: aPlans.body.plans, b: bPlans.body.plans }).slice(0, 300));

  /*
   * 看别的会话的选择器：必须显式带 `scope=workspace`，而且清单里**只有会话 id 和计数** ——
   * 计划正文要点头开那一行才读得到。
   */
  const pickerBare = await get('/api/plans/sessions');
  check('不带 scope=workspace 时选择器接口直接 400（不是悄悄给一份跨会话清单）',
    pickerBare.status === 400, `status=${pickerBare.status}`);
  const picker = await get('/api/plans/sessions?scope=workspace');
  const listed = picker.body?.sessions ?? [];
  check('显式要了才列（这一步是用户点开选择器）', picker.status === 200 && listed.length >= 2, JSON.stringify(listed));
  check('清单带计数，界面不用为每个会话再问一次',
    listed.every((s) => typeof s.plans === 'number' && s.plans > 0), JSON.stringify(listed));
  check('清单里没有计划正文（只有 id 和计数）',
    !JSON.stringify(listed).includes('网关') && !JSON.stringify(listed).includes('另一件事'), JSON.stringify(listed));

  const bMemo = await get('/api/memo?session_id=sess-b');
  check('/api/memo 只回点名那个会话的备忘', bMemo.body.entries.length === 0, JSON.stringify(bMemo.body).slice(0, 200));
  const crossWrite = await send('PUT', `/api/memo/${seedMemo.id}`, { done: true, session_id: 'sess-b' });
  check('拿 A 的备忘 id 从 B 改 → 404（改不到，也不会改到同名 id）', crossWrite.status === 404, `status=${crossWrite.status}`);
  const aMemoAfter = await get('/api/memo?session_id=sess-a');
  check('A 的备忘没有被 B 改过', aMemoAfter.body.entries[0]?.done === false, JSON.stringify(aMemoAfter.body.entries));

  const bRuns = await get('/api/runs?session_id=sess-b');
  check('/api/runs 默认只看点名那个会话', bRuns.body.runs.length === 0, JSON.stringify(bRuns.body.runs));
  const crossRun = await get(`/api/runs/${seedRun.id}?session_id=sess-b`);
  check('拿 A 的轨迹 id 从 B 读 → 404', crossRun.status === 404, `status=${crossRun.status}`);
  const noSession = await get(`/api/runs/${seedRun.id}`);
  check('单轮详情不带 session_id → 400（不猜一个会话去读）', noSession.status === 400, `status=${noSession.status}`);
  const ownRun = await get(`/api/runs/${seedRun.id}?session_id=sess-a`);
  check('点对了会话就读得到（上面那些 404 不是因为功能坏了）',
    ownRun.status === 200 && (ownRun.body.events ?? []).length >= 2, `status=${ownRun.status}`);
  /*
   * 证据核对：A 跑过 shell，B 没跑过。"B 的轨迹里有 shell"这句话不该成立 —— 拿别人的轨迹给
   * 我的说法背书，是这条接口最要防的方向（它存在的意义就是拦住编造的引用）。
   */
  const quote = encodeURIComponent('shell 跑过 pg_dump');
  const inB = await get(`/api/runs/corroborate?evidence=${quote}&session_id=sess-b`);
  const inA = await get(`/api/runs/corroborate?evidence=${quote}&session_id=sess-a`);
  check('证据核对只在点名的会话里成立（不拿别人的轨迹给我背书）',
    inB.body?.backed === false, JSON.stringify(inB.body).slice(0, 240));
  check('而这条证据在它真正的来源会话里成立（上面那个 false 不是"永远为假"）',
    inA.body?.backed === true, JSON.stringify(inA.body).slice(0, 240));

  const bReflect = await get('/api/reflection?session_id=sess-b');
  check('/api/reflection：样本是本会话的（B 没有样本）', bReflect.body.samples.length === 0, JSON.stringify(bReflect.body.samples));
  check('结论照读（数字账是共用的那半边）', bReflect.body.confidence.samples === 1, JSON.stringify(bReflect.body.confidence));
  check('B 的样本文件落点报的是 B 的目录',
    String(bReflect.body.samples_root).includes('sess-b'), bReflect.body.samples_root);

  /*
   * 重置的边界（有意为之，写清楚而不是让它变成惊讶）：数字账是不分会话的，所以在任何一个会话里
   * 重置都会清掉那本账；但**别人的样本文件不动** —— 那里面有它自己的文本，轮不到我来替它决定。
   */
  const reset = await send('POST', '/api/reflection/confidence/reset', { session_id: 'sess-b' });
  check('重置接口认识 body 里的 session_id（不是静默重置了"当前会话"）', reset.status === 200, `status=${reset.status}`);
  const afterReset = await get('/api/reflection?session_id=sess-b');
  check('重置后数字账空了（共用账的那半边）', afterReset.body.confidence.samples === 0, JSON.stringify(afterReset.body.confidence));
  check('A 自己的样本文件不替它清',
    JSON.parse(readFileSync(dims.样本(workspace, 'sess-a'), 'utf8')).samples.length === 1, null);
} catch (err) {
  check('隔离的接口检查没有抛异常', false, err?.stack ?? String(err));
}

cleanup();
removeTempDir(dir);

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}  session-isolation-check`);
process.exit(failures === 0 ? 0 : 1);
