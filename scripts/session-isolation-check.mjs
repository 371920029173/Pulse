/**
 * 状态边界：哪些东西是**一个会话私有**的，哪些是**一个工作区共享**的 —— 离线为主，最后真起一次服务。
 *
 * 2026-10-01 之前这里只钉一条边界："会话私有"，五个维度（计划 / 备忘 / 预检 / 轨迹 / 置信度样本）全都在
 * `.she/sessions/<id>/` 下面。那条边界**划错了一半**：计划和备忘记的是"这个项目里的活"，用户在一个项目里
 * 新开一个对话，期待的是昨天那份计划还在。把它们藏进会话目录，用户看到的是"我的计划丢了"。
 *
 * 现在有两条边界，各有各的理由，这份检查把它们分开钉：
 *
 *   A. **工作区级**（计划 / 备忘）：一个项目一份，项目里每条会话读写同一份；**跨工作区**读不到，因为
 *      另一个工作区有自己的 `.she/`。
 *   B. **会话级**（预检 / 轨迹 / 置信度样本）：一条对话的推理原文、跑过的命令、话题文本，不该被另一条
 *      对话读到 —— 这里的分账仍然是"路径上不存在"。
 *
 * 每条边界问三件事：
 *
 *   1. **路径**：A 类落在 `.she/` 顶层，B 类落在 `.she/sessions/<id>/` 下面；
 *   2. **读**：同工作区的另一条会话读得到 A 类、读不到 B 类；
 *   3. **写**：同工作区的另一条会话改得动 A 类（那是同一个项目的计划），改不动 B 类。
 *
 * 再加一层**反向钉子**：回归通常不是"过滤写漏了"，而是"顺手又建了一份工作区级文件"。所以两边都要响 ——
 * `.she/` 顶层不许出现 B 类那三样，会话目录里也不许再出现 A 类那两样。
 *
 * 唯一的例外是**跨会话的数字账**（`.she/reflection/confidence.json`），它是刻意共用的：习惯要跨重启才
 * 看得出来，而那里只有数字、没有一个字的话题文本。这份检查把这个例外也钉住：它的收益（B 能读到结论）
 * 和它的边界（话题文本不在里面）都要成立。
 *
 *   node scripts/session-isolation-check.mjs
 */
import { mkdtempSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
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

const { PlanStore, MemoStore, RunTraceStore, ConfidenceMirror, WORKSPACE_SCOPE } =
  await import(pathToFileURL(RUNTIME_ENTRY).href);
const { PreflightStore } = await import(pathToFileURL(PREFLIGHT_ENTRY).href);

const A = 'sess-alpha';
const B = 'sess-beta';

/**
 * 五个维度的落点 —— 写死的期望值，和实现自己报出来的路径分开比对。
 *
 * 前两个只跟工作区有关（所以签名里有 `s` 也不用），后三个必须落在自己的会话目录里。把这两类**并排写在
 * 一起**是有意的：边界一旦被改动，这张表就是最先要改的东西。
 */
const dims = {
  计划: (root) => join(root, '.she', 'plans.json'),
  备忘: (root) => join(root, '.she', 'memo.json'),
  预检: (root, s) => join(root, '.she', 'sessions', s, 'preflight'),
  轨迹: (root, s) => join(root, '.she', 'sessions', s, 'runs'),
  样本: (root, s) => join(root, '.she', 'sessions', s, 'confidence.json'),
};
const WORKSPACE_DIMS = ['计划', '备忘'];
const SESSION_DIMS = ['预检', '轨迹', '样本'];

/**
 * 这些 store 实际把文件放哪了。
 *
 * 和 `dims` 是两套：`dims` 是"应该在哪"，这里是"实现说它在哪"。两边一旦分叉，下面所有读/写断言都会对着
 * 空气，而且全是绿的 —— 所以先比这两套。
 *
 * 报法不统一（计划报的是所在目录、轨迹报的是 runs 子目录、备忘什么都不报），所以这里返回"它报出来的那个
 * 位置"，由调用方对着 `dims` 里对应的那一项做包含判断：文件的那一项要落在它下面。
 */
const reportedDirs = (root, sessionId) => ({
  计划: new PlanStore(root, WORKSPACE_SCOPE).directory,
  轨迹: new RunTraceStore(root, sessionId).directory(),
});

const dir = tempDir('she-isolation-');
const otherWorkspace = tempDir('she-isolation-other-');

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 路径：两类的落点各自正确
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n1. 路径：工作区级的在 `.she/` 顶层，会话级的在自己的会话目录里');
{
  const reported = reportedDirs(dir, A);
  for (const [name, where] of Object.entries(reported)) {
    /*
     * 每个 store 报出来的位置含义不一样（计划报所在目录、轨迹报 runs 目录），但要求是同一条：`dims` 里
     * 写死的那条路径必须落在它报出来的位置**下面**。报的比期望的大一级没关系（它报的是目录），报成别的
     * 地方就有关系了。
     */
    check(`${name}：写死的那条路径确实在它报出来的目录下`,
      resolve(dims[name](dir, A)).startsWith(resolve(where)), `${dims[name](dir, A)} vs ${where}`);
  }

  for (const name of SESSION_DIMS) {
    check(`${name}（会话级）：两个会话不是同一条路径`,
      !samePath(dims[name](dir, A), dims[name](dir, B)), dims[name](dir, A));
  }
  for (const name of WORKSPACE_DIMS) {
    check(`${name}（工作区级）：跟会话无关，两条会话就是同一份`,
      samePath(dims[name](dir, A), dims[name](dir, B)), dims[name](dir, A));
  }
  for (const name of Object.keys(dims)) {
    check(`${name}：路径确实在工作区里`,
      resolve(dims[name](dir, A)).startsWith(resolve(dir)), dims[name](dir, A));
  }

  /*
   * PreflightStore / ConfidenceMirror 不报路径，只能从它们写出来的文件反推 —— 这两样是"文件真的落在
   * 会话目录里"而不是"getter 说的是"。
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
 * 2. 读：同工作区的另一条会话读得到工作区级的，读不到会话级的
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n2. 读：同工作区的另一条会话 —— 计划/备忘看得到，预检/轨迹/样本看不到');
let seeded;
{
  const plan = new PlanStore(dir, WORKSPACE_SCOPE).create('把数据从 MySQL 搬到 Postgres', ['导出', '校验', '切流量']);
  const memo = new MemoStore(dir).add('迁移期间先停写', 'user');
  const run = new RunTraceStore(dir, A).begin({ prompt: '导出生产库', model: 'm-iso' });
  run.tool({ name: 'shell', args: '{"cmd":"pg_dump"}', result: 'ok', ms: 3, ok: true });
  run.end({ ok: true });
  new ConfidenceMirror(dir, A).observe({ claimed: 0.95, attempted: 4, succeeded: 1, topic: '数据迁移' });
  seeded = { plan, memo, run };

  // A 自己读得到 —— 否则下面"B 读不到"可能只是因为什么都没写进去。
  check('A 读得到自己的计划', new PlanStore(dir, WORKSPACE_SCOPE).list().some((p) => p.title.includes('搬')), null);
  check('A 读得到自己的备忘', new MemoStore(dir).list().length === 1, null);
  check('A 读得到自己的预检', new PreflightStore(dir, A).list().length === 1, null);
  check('A 读得到自己的轨迹', new RunTraceStore(dir, A).list().length === 1, null);
  check('A 读得到自己的样本', new ConfidenceMirror(dir, A).samples().length === 2, null);

  /*
   * 工作区级：另一条**会话**（不是另一个工作区）看得到。这就是"在一个项目里新开一个对话，昨天那份计划
   * 还在"这条承诺的实现方式 —— 它靠的不是过滤，是两边读同一份文件。
   */
  check('【关键】同工作区的 B 看得到这份计划（计划属于项目）',
    new PlanStore(dir, WORKSPACE_SCOPE).list().length === 1, null);
  check('【关键】同工作区的 B 看得到这份备忘',
    new MemoStore(dir).list().length === 1, null);

  // 会话级：仍然读不到，而且是"路径上不存在"。
  check('B 读不到 A 的预检', new PreflightStore(dir, B).list().length === 0, null);
  check('B 读不到 A 的轨迹', new RunTraceStore(dir, B).list().length === 0, null);
  check('B 读不到 A 的样本（话题文本是 A 的）', new ConfidenceMirror(dir, B).samples().length === 0, null);
  check('B 的会话目录里没有被凭空造出来的文件',
    !existsSync(dims.预检(dir, B)) && !existsSync(dims.样本(dir, B)), null);

  /*
   * 工作区级：换一个**工作区**就什么都读不到了 —— 边界只是挪到了用户认识的那条线上，并没有变松。
   */
  check('【关键】另一个工作区读不到这份计划', new PlanStore(otherWorkspace, WORKSPACE_SCOPE).list().length === 0, null);
  check('【关键】另一个工作区读不到这份备忘', new MemoStore(otherWorkspace).list().length === 0, null);
  check('【关键】隔离靠路径：另一个工作区连文件都没有',
    !existsSync(dims.计划(otherWorkspace)) && !existsSync(dims.备忘(otherWorkspace)), null);

  /* ══════════════════════════════════════════════════════════════════════
   * 3. 写：工作区级的改得动，会话级的改不动
   * ══════════════════════════════════════════════════════════════════════ */
  console.log('\n3. 写：同项目的计划/备忘改得动；别人的预检/轨迹改不动');

  const preflightBefore = readFileSync(join(dims.预检(dir, A), readdirSync(dims.预检(dir, A))[0]), 'utf8');

  /*
   * 计划：同工作区就是同一份，所以"改"是正当的，而且是这次改动的**目的**。用户在一个项目里换一条
   * 对话接着做，本来就该能推进度。
   */
  const advanced = new PlanStore(dir, WORKSPACE_SCOPE).setStepStatus(plan.id, plan.steps[0].id, 'done');
  check('【关键】同工作区的另一条会话推得动这份计划的进度', advanced.ok === true, JSON.stringify(advanced).slice(0, 200));
  check('进度真的落到同一份文件里',
    new PlanStore(dir, WORKSPACE_SCOPE).get(plan.id)?.steps[0].status === 'done', null);

  const memoEdit = new MemoStore(dir).update(memo.id, { done: true });
  check('【关键】同工作区的另一条会话改得动这条备忘', memoEdit?.done === true, null);

  // 另一个工作区：既读不到也改不动（它读的是自己的文件，所以这里是"没有这条"）。
  const foreignEdit = new PlanStore(otherWorkspace, WORKSPACE_SCOPE).setStepStatus(plan.id, plan.steps[0].id, 'done');
  check('【关键】另一个工作区改不动这份计划', foreignEdit.ok === false, JSON.stringify(foreignEdit).slice(0, 200));
  const foreignMemo = new MemoStore(otherWorkspace).update(memo.id, { done: false });
  check('【关键】另一个工作区也找不到这条备忘', foreignMemo === undefined, null);

  // 会话级：从 B 拿 A 的轨迹 id 读不到；A 的预检文件一个字节没变。
  check('拿 A 的轨迹 id 从 B 读：读不到', new RunTraceStore(dir, B).read(run.id) == null, null);
  check('A 的预检文件一个字节都没变',
    readFileSync(join(dims.预检(dir, A), readdirSync(dims.预检(dir, A))[0]), 'utf8') === preflightBefore, null);

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
   * 5. 反向钉子：两条边界都不能长歪
   * ══════════════════════════════════════════════════════════════════════ */
  console.log('\n5. 反向钉子：工作区级的留在顶层，会话级的不许上顶层，也不许再回落进会话目录');

  const top = readdirSync(join(dir, '.she'));
  for (const name of ['plans.json', 'memo.json']) {
    check(`.she/ 顶层有 ${name}（工作区级就该在这里）`, top.includes(name), top.join(', '));
  }
  check('.she/ 顶层没有一个装所有会话的 confidence.json', !top.includes('confidence.json'), top.join(', '));
  check('.she/ 顶层没有 preflight / runs', !top.includes('preflight') && !top.includes('runs'), top.join(', '));

  /*
   * 另一半：2026-09-27 那版把这两样塞进了会话目录，改回来之后**不许**再有会话级副本 —— 否则同一份计划
   * 会出现两个来源，读的写的是哪一个就说不清了。
   */
  check('会话目录里不再有 plans.json（计划只有工作区那一份）',
    !existsSync(join(dir, '.she', 'sessions', A, 'plans.json')), null);
  check('会话目录里不再有 memo.json（备忘只有工作区那一份）',
    !existsSync(join(dir, '.she', 'sessions', A, 'memo.json')), null);
  /*
   * 上面两条只证明"没人在会话目录里写过这两个文件"。真正要钉的是**规则**：非工作区作用域（群、以及
   * 将来任何按会话分的作用域）必须落在会话目录里，工作区作用域必须落在顶层。用 `fileFor` 直接问，
   * 就不依赖"某个 store 恰好没被创建过"。
   */
  check('作用域决定落点：非工作区作用域落在会话目录里',
    samePath(PlanStore.fileFor(dir, A), join(dir, '.she', 'sessions', A, 'plans.json')),
    PlanStore.fileFor(dir, A));
  check('作用域决定落点：工作区作用域落在顶层',
    samePath(PlanStore.fileFor(dir, WORKSPACE_SCOPE), join(dir, '.she', 'plans.json')),
    PlanStore.fileFor(dir, WORKSPACE_SCOPE));
  check('会话级的那三样仍然长在会话目录里',
    existsSync(dims.预检(dir, A)) && existsSync(dims.轨迹(dir, A)) && existsSync(dims.样本(dir, A)), null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 真起服务：接口层跟 store 层说同一件事
 * ══════════════════════════════════════════════════════════════════════════ */

const PORT = String(await pickSafePort(Number(process.env.SHE_ISOLATION_TEST_PORT || 18171), [18172, 18173, 18174, 19192]));
const workspace = tempDir('she-isolation-live-');

// 先在线下把状态写好，服务起来就有东西可读。
const seedPlan = new PlanStore(workspace, WORKSPACE_SCOPE, 'sess-a').create('把网关换成新版本', ['灰度', '全量']);
const seedMemo = new MemoStore(workspace).add('网关切换前先备份路由表', 'user');
const seedRun = new RunTraceStore(workspace, 'sess-a').begin({ prompt: '导出生产库', model: 'm-iso' });
seedRun.tool({ name: 'shell', args: '{"cmd":"pg_dump prod"}', result: 'ok', ms: 2, ok: true });
seedRun.end({ ok: true });
new ConfidenceMirror(workspace, 'sess-a').observe({ claimed: 0.9, attempted: 4, succeeded: 1, topic: '网关切换' });
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

console.log('\n6. /api：接口层跟 store 层说同一件事');
if (!(await waitForHealth())) {
  console.log('  FAIL  服务在 30 秒内就绪');
  console.log(`        ${serverOut.slice(-800)}`);
  cleanup();
  removeTempDir(dir);
  removeTempDir(otherWorkspace);
  console.log('\nFAIL (1)  session-isolation-check');
  process.exit(1);
}

try {
  /*
   * 计划：不管点名哪条会话，回的都是**本工作区那一份**。这正是"计划属于项目"在接口上的样子 ——
   * 2026-09-27 那版这里回的是"点名那个会话的文件"。
   */
  const aPlans = await get('/api/plans?session_id=sess-a');
  const bPlans = await get('/api/plans?session_id=sess-b');
  const noSessionPlans = await get('/api/plans');
  check('【关键】点名的会话不同，读到的计划是同一份（工作区级）',
    aPlans.body.plans.length === 1 && bPlans.body.plans.length === 1
      && aPlans.body.plans[0].id === seedPlan.id && bPlans.body.plans[0].id === seedPlan.id,
    JSON.stringify({ a: aPlans.body.plans?.map((p) => p.id), b: bPlans.body.plans?.map((p) => p.id) }).slice(0, 300));
  check('不带 session_id 也读得到（边界是工作区，不是会话）',
    noSessionPlans.body.plans.length === 1 && noSessionPlans.body.plans[0].id === seedPlan.id,
    JSON.stringify(noSessionPlans.body.plans?.map((p) => p.id)).slice(0, 200));
  check('计划带着创建它的会话 id（来源标记）',
    aPlans.body.plans[0].sessionId === 'sess-a', JSON.stringify(aPlans.body.plans[0].sessionId));

  /*
   * 备忘同样是工作区级：两条会话读到同一份，改也改得动同一份。
   */
  const aMemo = await get('/api/memo?session_id=sess-a');
  const bMemo = await get('/api/memo?session_id=sess-b');
  check('【关键】两条会话读到的是同一本备忘',
    aMemo.body.entries.length === 1 && bMemo.body.entries.length === 1
      && aMemo.body.entries[0].id === bMemo.body.entries[0].id,
    JSON.stringify({ a: aMemo.body.entries, b: bMemo.body.entries }).slice(0, 300));
  const bWritesMemo = await send('PUT', `/api/memo/${seedMemo.id}`, { done: true, session_id: 'sess-b' });
  check('【关键】从另一条会话改得动这条备忘（同一个项目的本子）', bWritesMemo.status === 200, `status=${bWritesMemo.status}`);
  const aMemoAfter = await get('/api/memo?session_id=sess-a');
  check('改动在两条会话里都看得见', aMemoAfter.body.entries[0]?.done === true, JSON.stringify(aMemoAfter.body.entries));

  /*
   * 清单接口：它现在只枚举**目录作用域**（讨论群）。聊天计划本来就在上面那条接口里全部可见，所以
   * 清单里**不该**出现任何聊天会话 —— 否则界面上会多出一扇没有必要的门。
   */
  const pickerBare = await get('/api/plans/sessions');
  check('不带 scope=workspace 时清单接口直接 400（枚举目录名是显式动作）',
    pickerBare.status === 400, `status=${pickerBare.status}`);
  const picker = await get('/api/plans/sessions?scope=workspace');
  check('聊天会话不进清单（它的计划本来就看得到）',
    picker.status === 200 && !(picker.body?.sessions ?? []).some((s) => s.session_id.startsWith('sess_')),
    JSON.stringify(picker.body?.sessions).slice(0, 240));

  /*
   * 会话级那三样：接口层必须仍然是"点名的会话才看得到"。
   */
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
   * 证据核对：A 跑过 shell，B 没跑过。"B 的轨迹里有 shell"这句话不该成立 —— 拿别人的轨迹给我的说法
   * 背书，是这条接口最要防的方向（它存在的意义就是拦住编造的引用）。
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
   * 重置的边界（有意为之，写清楚而不是让它变成惊讶）：数字账是不分会话的，所以在任何一个会话里重置都会
   * 清掉那本账；但**别人的样本文件不动** —— 那里面有它自己的文本，轮不到我来替它决定。
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

/* ══════════════════════════════════════════════════════════════════════════
 * 7. 会话栈：只能看到本工作区的 chat
 *
 * 这一节是 2026-10-01 补的，因为上面所有断言都是绿的、而用户看到的仍然是"隔离完全无效"。
 * 漏掉的那半边不在 store 里，在**接口层**：`/api/conversations` 遍历 `projectRoots()`（所有被记住
 * 过的项目）把会话合并成一条列表，于是任何工作区打开都看得见别的项目的对话。分账在磁盘上是对的，
 * 而用户看的是界面。
 *
 * 另一个同源的漏洞在启动路径：`recoverLegacyState` 会从**安装根目录**搬 `sessions.json` 进任何还
 * 没有这个文件的工作区。于是新建一个空工作区，里面凭空出现安装根的对话 —— 单靠这条就能复现"隔离
 * 无效"。所以这一节起一个**全新**的空工作区，第一条断言就是"它里面什么都没有"。
 *
 * 这次起的服务**不设 `SHE_STATE_DIR`**：那个变量是显式的"所有状态都放这里"覆盖，设了它工作区切换
 * 就不换会话（这是设计如此）。要测"工作区边界"就得让它跟着工作区走。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n7. 会话栈：只列本工作区的 chat（不是所有项目的）');

const liveRoot = tempDir('she-rail-live-');
const liveOther = tempDir('she-rail-other-');
const OTHER_PORT = String(await pickSafePort(Number(process.env.SHE_RAIL_TEST_PORT || 18191), [18192, 18193]));

const liveChild = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: liveRoot,
    SHE_PORT: OTHER_PORT,
    SHE_ENV_FILE: join(liveRoot, '.env'),
    SHE_APP_DIR: join(liveRoot, 'appdir'),
    // 刻意不设 SHE_STATE_DIR：状态目录要跟着工作区走。
    SHE_STATE_DIR: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let liveOut = '';
liveChild.stdout.on('data', (c) => { liveOut += c; });
liveChild.stderr.on('data', (c) => { liveOut += c; });

const live = (path, init) => fetch(`http://127.0.0.1:${OTHER_PORT}${path}`, { signal: AbortSignal.timeout(8000), ...init });
const liveGet = async (path) => {
  const r = await live(path);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const livePost = (path, body) => live(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

async function liveReady() {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${OTHER_PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > 30_000) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

const liveCleanup = () => {
  killTree(liveChild.pid);
  removeTempDir(liveRoot);
  removeTempDir(liveOther);
};

if (!(await liveReady())) {
  check('第二个服务在 30 秒内就绪', false, liveOut.slice(-800));
  liveCleanup();
} else {
  try {
    /*
     * 空工作区的第一条断言：**真的是空的**。
     *
     * 这一条同时钉住 `recoverLegacyState`：仓库自己的 `.she/sessions.json` 里是有会话的，如果那条
     * 恢复逻辑又跑去安装根目录搬，这里立刻不是 0。
     */
    const fresh = await liveGet('/api/sessions');
    const freshRail = await liveGet('/api/conversations');
    check('【关键】全新的空工作区里一条会话都没有（安装根的对话没被搬进来）',
      fresh.body.sessions.length === 0 && freshRail.body.items.length === 0,
      JSON.stringify({ sessions: fresh.body.sessions?.map((s) => s.title), rail: freshRail.body.items?.map((s) => s.title) }).slice(0, 300));
    check('空工作区的 active_id 是 null（没有替用户建会话）', fresh.body.active_id === null, String(fresh.body.active_id));

    // 建两条，间隔一秒让 updated_at 分得开。
    const first = await (await livePost('/api/sessions', { title: '甲的活' })).json();
    await new Promise((r) => setTimeout(r, 1100));
    await livePost('/api/sessions', { title: '乙的活' });
    await new Promise((r) => setTimeout(r, 1100));
    await livePost('/api/sessions', { title: '丙的活' });

    const afterCreate = await liveGet('/api/conversations');
    const titles = (r) => (r.body.items ?? []).map((i) => i.title);
    check('新建的会话排在最前面（按创建时间倒序）',
      titles(afterCreate).join(',') === '丙的活,乙的活,甲的活',
      titles(afterCreate).join(','));

    /*
     * 排序的核心断言：**被激活的那条跳到最前面**，而且两条接口给同一个顺序。
     *
     * 只 hoist 不抬 `updated_at` 时，`/api/sessions` 把它排第一、会话栈按时间戳把它排第三 —— 实测
     * 2026-10-01 亲眼看到这个分叉。所以这里两个都要比。
     */
    await livePost(`/api/sessions/${first.id}/activate`);
    const afterActivate = await liveGet('/api/sessions');
    const railAfter = await liveGet('/api/conversations');
    check('【关键】激活一条老会话后它排到最上面（按活跃排序，不是按创建排序）',
      (afterActivate.body.sessions ?? [])[0]?.id === first.id,
      (afterActivate.body.sessions ?? []).map((s) => s.title).join(','));
    check('【关键】/api/sessions 和 /api/conversations 给的顺序一致（同一批数据不该有两种排法）',
      (afterActivate.body.sessions ?? []).map((s) => s.id).join(',') === (railAfter.body.items ?? []).map((s) => s.id).join(','),
      JSON.stringify({ store: (afterActivate.body.sessions ?? []).map((s) => s.title), rail: titles(railAfter) }).slice(0, 300));

    /*
     * 点一次 `+` 只加一条 —— 这条钉住"启动时替用户建会话"那个 bug：以前空工作区启动会先有一条
     * `New chat`（无消息），用户再点 + 就是两条。
     */
    const beforeCount = (await liveGet('/api/sessions')).body.sessions.length;
    await livePost('/api/sessions', { title: '只加一条' });
    const grown = (await liveGet('/api/sessions')).body.sessions.length;
    check('【关键】点一次「+」只多一条（启动不再悄悄建会话）',
      grown === beforeCount + 1, `${beforeCount} -> ${grown}`);

    /*
     * 换一个工作区：**看不到**上面那批。这一条是"会话隔离"最直白的表述。
     */
    const switched = await livePost('/api/workspaces/switch', { root: liveOther });
    const swBody = await switched.json().catch(() => null);
    check('切到一个还没用过的工作区，activeSessionId 是 null（不假装打开了一条）',
      swBody?.activeSessionId === null, JSON.stringify(swBody).slice(0, 240));
    await new Promise((r) => setTimeout(r, 1200));

    const otherRail = await liveGet('/api/conversations');
    check('【关键】另一个工作区的会话栈是空的（看不到上一个工作区的 chat）',
      (otherRail.body.items ?? []).length === 0, titles(otherRail).join(','));
    const otherSessions = await liveGet('/api/sessions');
    check('另一个工作区的 /api/sessions 也是空的',
      (otherSessions.body.sessions ?? []).length === 0,
      (otherSessions.body.sessions ?? []).map((s) => s.title).join(','));

    // 在第二个工作区里建一条，它不该跑回第一个工作区去。
    await livePost('/api/sessions', { title: '乙区的活' });
    const otherOwn = await liveGet('/api/conversations');
    check('第二个工作区里建的会话只属于它',
      titles(otherOwn).join(',') === '乙区的活', titles(otherOwn).join(','));

    // 切回去：原来那批原样都在，且看不见第二个工作区那条。
    await livePost('/api/workspaces/switch', { root: liveRoot });
    await new Promise((r) => setTimeout(r, 1200));
    const backRail = await liveGet('/api/conversations');
    const backTitles = titles(backRail);
    check('【关键】切回来，原来那批一条不少',
      backTitles.length === grown, `${backTitles.length} vs ${grown}: ${backTitles.join(',')}`);
    check('【关键】第一个工作区里看不到第二个工作区建的会话',
      !backTitles.includes('乙区的活'), backTitles.join(','));

    /*
     * 边界靠路径，不靠过滤：两个工作区各自有文件，而第二个工作区**没有**从第一个那里继承。
     */
    check('两个工作区各自有自己的 sessions.json',
      existsSync(join(liveRoot, '.she', 'sessions.json')) && existsSync(join(liveOther, '.she', 'sessions.json')),
      null);
    const rootFile = JSON.parse(readFileSync(join(liveRoot, '.she', 'sessions.json'), 'utf8'));
    check('第一个工作区的文件里没有被写进第二个工作区的会话',
      !(rootFile.sessions ?? []).some((s) => s.title === '乙区的活'),
      (rootFile.sessions ?? []).map((s) => s.title).join(','));
  } catch (err) {
    check('会话栈的接口检查没有抛异常', false, err?.stack ?? String(err));
  }
  liveCleanup();
}

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 「建了却看不见」：创建和列表必须落在同一个 store
 *
 * 这一节是 2026-10-01 补的，和第 7 节同一个病根的另一半。
 *
 * 第 6 节把 `SHE_STATE_DIR` 设成**和 workspace 一模一样**，第 7 节干脆不设 —— 两种情况里
 * `stateDir === config.workspace.root` 都成立，于是"创建用哪个 store、列表读哪个 store"这个问题
 * 从来没被问过。而 `SHE_STATE_DIR` 的整个用途就是**让它和 workspace 不一样**：
 *
 *     POST /api/sessions    → storeFor(config.workspace.root)   ← 写在 <workspace>/.she
 *     GET  /api/conversations → sessions（挂载的 stateDir）      ← 读 <stateDir>/.she
 *
 * 实测（本地 2026-10-01，隔离实例 5878）：连续 4 次 `POST /api/sessions` 全部 201，行落在
 * `_e2e_ws/.she/sessions.json`，而会话栈一直是"暂无会话"，同时 `GET /api/sessions/:id` 对每个 id 都
 * 回 200 —— 创建成功、单条可读、列表里永远没有。用户看到的就是"我新建的对话不见了"，而强刷页面
 * 救不了它：两边在磁盘上就不一致，不在内存里。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n8. 建了就要看得见：创建与列表落在同一个 store（SHE_STATE_DIR ≠ workspace）');

const splitWorkspace = tempDir('she-split-ws-');
const splitState = tempDir('she-split-state-');
const SPLIT_PORT = String(await pickSafePort(Number(process.env.SHE_SPLIT_TEST_PORT || 18195), [18196, 18197]));

const splitChild = spawn('node', [SERVER_ENTRY], {
  cwd: SERVER_DIR,
  env: {
    ...process.env,
    SHE_WORKSPACE: splitWorkspace,
    SHE_PORT: SPLIT_PORT,
    SHE_ENV_FILE: join(splitWorkspace, '.env'),
    SHE_APP_DIR: join(splitWorkspace, 'appdir'),
    // 关键：状态目录**故意**不等于工作区。这是这个变量的正常用法，不是边角情况。
    SHE_STATE_DIR: splitState,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let splitOut = '';
splitChild.stdout.on('data', (c) => { splitOut += c; });
splitChild.stderr.on('data', (c) => { splitOut += c; });

const splitGet = async (path) => {
  const r = await fetch(`http://127.0.0.1:${SPLIT_PORT}${path}`, { signal: AbortSignal.timeout(8000) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const splitPost = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${SPLIT_PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(8000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

async function splitReady() {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${SPLIT_PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > 30_000) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

const splitCleanup = () => {
  killTree(splitChild.pid);
  removeTempDir(splitWorkspace);
  removeTempDir(splitState);
};

if (!(await splitReady())) {
  check('第一个服务在 30 秒内就绪', false, splitOut.slice(-800));
  splitCleanup();
} else {
  try {
    const created = await splitPost('/api/sessions', { title: '状态目录在别处' });
    check('创建会话返回 201', created.status === 201, `${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
    const id = created.body?.id;

    const one = await splitGet(`/api/sessions/${id}`);
    check('按 id 能读到刚建的那条', one.status === 200, String(one.status));

    const rail = await splitGet('/api/conversations');
    const listed = (rail.body?.items ?? []).some((s) => s.id === id);
    check('【关键】刚建的会话出现在会话栈里（创建与列表同一个 store）',
      listed, `rail=${JSON.stringify((rail.body?.items ?? []).map((s) => s.title))}`);

    const list = await splitGet('/api/sessions');
    check('【关键】/api/sessions 也列得出来',
      (list.body?.sessions ?? []).some((s) => s.id === id),
      JSON.stringify((list.body?.sessions ?? []).map((s) => s.title)));

    /*
     * 落点必须**只有一个**。两边都写一份是最坏的结果：文件看起来都在，而会话栈只认其中一份，
     * 于是"我的对话有时在有时不在"。这里直接问磁盘。
     */
    const inState = existsSync(join(splitState, '.she', 'sessions.json'))
      && JSON.parse(readFileSync(join(splitState, '.she', 'sessions.json'), 'utf8')).sessions.some((s) => s.id === id);
    const wsFile = join(splitWorkspace, '.she', 'sessions.json');
    const inWorkspace = existsSync(wsFile)
      && (JSON.parse(readFileSync(wsFile, 'utf8')).sessions ?? []).some((s) => s.id === id);
    check('会话写在状态目录的那份文件里', inState, `state=${inState} workspace=${inWorkspace}`);
    check('工作区那份文件里没有再写一份（否则两份清单会各说各话）', !inWorkspace, String(inWorkspace));
  } catch (err) {
    check('状态目录分家的接口检查没有抛异常', false, err?.stack ?? String(err));
  }
  splitCleanup();
}

removeTempDir(dir);
removeTempDir(otherWorkspace);

/* ══════════════════════════════════════════════════════════════════════════
 * 9. 临时工作区不许变成"下次启动就回到这里"
 *
 * 这一节是 2026-10-01 补的，原因是真机上发生的事：应用被切到 `D:\AGI\_she-live-test_2`（两条测试
 * 对话），而用户自己的项目还在盘上、对话也还在，只是界面上哪儿都看不到。
 *
 * 机制是这样的：`mountWorkspace` 会把 `SHE_WORKSPACE` 写进**安装目录真正的 `.env`**，这样下次启动
 * 回到你上次待的项目。对项目是对的，对临时目录是错的 —— 只要被指过去一次，之后每次启动都从那里
 * 开始，而界面上没有任何东西说明这件事。
 *
 * 所以这里钉两条，缺一不可：
 *   - 切到临时目录：`.env` **不能**被改成它（否则一次误点变成永久默认）；
 *   - 切到普通目录：`.env` **必须**被改成它（否则"永远不写"也能让上一条通过，而那样等于把
 *     "记住上次的工作区"这个功能整个删掉）。
 *
 * 普通目录用仓库里 `.she/check-ws/` 下的一个空目录：它不在系统 temp 里，名字也不匹配任何测试夹具
 * 约定，所以判定上就是"一个正常项目"。用完删掉。
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n9. 临时工作区不写进 .env 默认（切走就忘），普通项目照常记住');

{
  const envWorkspace = tempDir('she-env-scratch-');
  const envScratch = tempDir('she-env-target-');
  const ENV_PORT = String(await pickSafePort(Number(process.env.SHE_ENV_TEST_PORT || 18201), [18202, 18203]));
  const envFile = join(envWorkspace, '.env');

  /*
   * 这个目标目录是"正常项目"那一半的对照。建在仓库的 `.she/` 下面是为了可控：不在 tmpdir 里
   * （`isScratchWorkspace` 的两条判据都不成立），用完能一次删干净。
   */
  const normalDir = join(ROOT, '.she', 'check-ws', 'proj');
  mkdirSync(normalDir, { recursive: true });

  const envChild = spawn('node', [SERVER_ENTRY], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      SHE_WORKSPACE: envWorkspace,
      SHE_PORT: ENV_PORT,
      SHE_ENV_FILE: envFile,
      SHE_APP_DIR: join(envWorkspace, 'appdir'),
      SHE_STATE_DIR: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let envOut = '';
  envChild.stdout.on('data', (c) => { envOut += c; });
  envChild.stderr.on('data', (c) => { envOut += c; });

  const envReady = await (async () => {
    const t0 = Date.now();
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${ENV_PORT}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (r.ok) return true;
      } catch { /* not up yet */ }
      if (Date.now() - t0 > 30_000) return false;
      await new Promise((r) => setTimeout(r, 400));
    }
  })();

  if (!envReady) {
    check('第 9 节的服务在 30 秒内就绪', false, envOut.slice(-800));
  } else {
    try {
      const switchTo = (root) => fetch(`http://127.0.0.1:${ENV_PORT}/api/workspaces/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root }),
        signal: AbortSignal.timeout(8000),
      });

      /*
       * 基准取"切换前那一行"，而不是断言它一定存在。
       *
       * 启动不写这一行（只有**切换**才写），所以断言"启动时已经有 SHE_WORKSPACE"是在赌启动路径的
       * 实现。真正的不变量是"切到临时目录**不改动**这一行"：它可能是空、可能指向别的目录，切完
       * 必须还是原样。
       */
      const lineOf = (text) => text.split('\n').find((l) => l.startsWith('SHE_WORKSPACE=')) ?? null;
      const before = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
      const beforeLine = lineOf(before);

      const sw = await switchTo(envScratch);
      check('切到临时目录成功（否则下面的断言无从谈起）', sw.status === 200, `status=${sw.status}`);
      await new Promise((r) => setTimeout(r, 900));

      const afterScratch = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
      const afterLine = lineOf(afterScratch);
      check('【关键】切到临时目录后 .env 那一行原样没动（不会被记成默认）',
        afterLine === beforeLine,
        `${beforeLine ?? '(没有这一行)'} -> ${afterLine ?? '(没有这一行)'}`);

      /*
       * 对照：普通项目目录**必须**被记住。
       *
       * 这一条防的是"把 `updateEnvFile` 整个删掉"这种假绿 —— 那样上面那条也会过，而功能没了。
       */
      const sw2 = await switchTo(normalDir);
      check('切到普通项目目录成功', sw2.status === 200, `status=${sw2.status}`);
      await new Promise((r) => setTimeout(r, 900));

      const afterNormal = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
      const line = lineOf(afterNormal) ?? '';
      check('【关键】切到普通项目后 .env 记下了它（说明上面那条不是"永远不写"）',
        line.includes('check-ws') && line.includes('proj'),
        line);
    } catch (err) {
      check('临时工作区的 .env 检查没有抛异常', false, err?.stack ?? String(err));
    }
  }

  killTree(envChild.pid);
  removeTempDir(envWorkspace);
  removeTempDir(envScratch);
  removeTempDir(join(ROOT, '.she', 'check-ws'));
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}  session-isolation-check`);
process.exit(failures === 0 ? 0 : 1);
