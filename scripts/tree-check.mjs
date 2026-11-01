/*
 * check:tree —— 任务树的最小断言集（离线、不调模型）。
 *
 * 钉住的是几条**语义**，不是实现细节：
 *   1. 树能长：子任务与同级任务都挂在正确的位置；
 *   2. 不可逆问题永不自动采纳（哪怕设置"相信"）—— 这是这套功能最危险的一处；
 *   3. 超时 + 相信 → 采纳推荐值并留痕（auto=true）；
 *   4. 超时 + 不相信 + blocking → 判定受阻；
 *   5. done 无证据会被标出来；
 *   6. 坏文件隔离、每会话一棵树（不跨 chat）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskTreeStore, DEFAULT_TREE_SETTINGS, treeAutopilot } from '../packages/agent-runtime/dist/task-tree.js';

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const dir = mkdtempSync(join(tmpdir(), 'she-tree-check-'));

/* ① 长树：子任务 + 同级任务 */
{
  const store = new TaskTreeStore(dir, 'sess_a');
  store.create('目标：把 A 做完', 'done = A 通过测试', ['第一步']);
  const root = store.get().rootId;
  const child = store.add({ parentId: root, title: '新发现的子任务' });
  const sib = store.add({ siblingOf: child.id, title: '同级的另一条路' });
  const tree = store.get();
  check('子任务挂在父节点下', tree.nodes.find((n) => n.id === child.id).parentId === root);
  check('同级任务与它同父', tree.nodes.find((n) => n.id === sib.id).parentId === root);
}

/* ② 不可逆问题永不自动采纳 */
{
  const settings = { ...DEFAULT_TREE_SETTINGS, trustModel: true, answerTimeoutMs: 0 };
  const store = new TaskTreeStore(dir, 'sess_b', settings);
  store.create('不可逆', undefined, ['删库']);
  const n = store.get().nodes[1];
  store.ask(n.id, { text: '要不要删库？', options: ['删', '不删'], recommend: '删', blocking: true, reversible: false });
  const swept = store.sweep();
  const q = store.get().nodes.find((x) => x.id === n.id).questions[0];
  check('不可逆问题即使设置「相信」也不会自动采纳', q.answeredAt === undefined && swept.auto.length === 0,
    `answered=${q.answeredAt ?? 'no'} auto=${swept.auto.length}`);
  check('不可逆 + blocking → 判定受阻', swept.blocked === true, `blocked=${swept.blocked}`);
}

/* ③ 可逆 + 相信 → 自动采纳并留痕 */
{
  const settings = { ...DEFAULT_TREE_SETTINGS, trustModel: true, answerTimeoutMs: 0 };
  const store = new TaskTreeStore(dir, 'sess_c', settings);
  store.create('可逆', undefined, ['选个方案']);
  const n = store.get().nodes[1];
  store.ask(n.id, { text: '用哪种缓存？', options: ['LRU', 'FIFO'], recommend: 'LRU', blocking: false, reversible: true });
  const swept = store.sweep();
  const node = store.get().nodes.find((x) => x.id === n.id);
  const q = node.questions[0];
  check('可逆 + 相信 → 自动采纳推荐值', q.autoAnswered === true && q.answer === 'LRU', `${q.answer} auto=${q.autoAnswered}`);
  check('自动决策留痕（decisions.auto=true）', node.decisions.some((d) => d.auto && d.choice === 'LRU'),
    JSON.stringify(node.decisions));
  check('sweep 报告了这次自动采纳', swept.auto.length === 1);
}

/* ④ 可逆 + 不相信 → 继续搁置；blocking 则受阻 */
{
  const settings = { ...DEFAULT_TREE_SETTINGS, trustModel: false, answerTimeoutMs: 0 };
  const store = new TaskTreeStore(dir, 'sess_d', settings);
  store.create('不信任', undefined, ['等答案']);
  const n = store.get().nodes[1];
  store.ask(n.id, { text: '要哪条路？', options: ['A', 'B'], recommend: 'A', blocking: true, reversible: true });
  const swept = store.sweep();
  const q = store.get().nodes.find((x) => x.id === n.id).questions[0];
  check('不相信 → 不会自动回答', q.answeredAt === undefined, `${q.answeredAt ?? 'no'}`);
  check('不相信 + blocking → 受阻', swept.blocked === true, `blocked=${swept.blocked}`);
}

/* ⑤ 每会话一棵树：另一个会话看不到 */
{
  const a = new TaskTreeStore(dir, 'sess_x');
  a.create('X 的树');
  const b = new TaskTreeStore(dir, 'sess_y');
  check('不同会话各自一棵树（不跨 chat 同步）', b.get() === null, `b=${b.get() ? '有' : '无'}`);
}

/* ⑥ 坏文件隔离 */
{
  const badDir = join(dir, '.she', 'sessions', 'sess_bad');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'tree.json'), '{ not json', 'utf8');
  const reopened = new TaskTreeStore(dir, 'sess_bad');
  const got = reopened.get();
  const info = reopened.recoveryInfo();
  const backups = readdirSync(join(dir, '.she', 'sessions', 'sess_bad')).filter((f) => f.includes('.corrupt-'));
  check('坏树文件被隔离而不是被当成空', got === null && Boolean(info) && backups.length >= 1,
    `recovery=${info ? 'yes' : 'no'} backups=${backups.join(',') || 'none'}`);
}

/* ⑦ done 无证据在渲染里被标出来 */
{
  const store = new TaskTreeStore(dir, 'sess_ev');
  store.create('证据', undefined, ['没证据的一步']);
  const n = store.get().nodes[1];
  store.update(n.id, { status: 'done', note: '直接标完成' });
  const { renderTree } = await import('../packages/agent-runtime/dist/tree-tools.js');
  const text = renderTree(store.get());
  check('done 无证据会被标出来', text.includes('无证据'), text.split('\n')[1] ?? '');
}

/* ⑧ 预算到顶时 tree_get 会要求收口（不靠模型自觉） */
{
  const strict = new TaskTreeStore(dir, 'sess_budget', { trustModel: false, answerTimeoutMs: 300000, maxMinutes: 0, maxNodeAttempts: 3, maxNodes: 60, backupBeforeAuto: true });
  strict.create('预算', undefined, ['一件没做完的事']);
  const b = strict.budget();
  check('maxMinutes 到顶 → budget() 说该收口了', b.exhausted === true, b.reason);
  check('理由里点明是时间预算', /分钟/.test(b.reason), b.reason);

  const { renderTree } = await import("../packages/agent-runtime/dist/tree-tools.js");
  const rendered = renderTree(strict.get());
  check('渲染里没有吓人字样（渲染是纯视图）', !rendered.includes('⛔'), 'ok');
}

/* ⑨ 没到顶时不能乱喊收口 */
{
  const normal = new TaskTreeStore(dir, 'sess_budget2');
  normal.create('正常', undefined, ['一件没做完的事']);
  check('刚建好的树不会被误判为预算用尽', normal.budget().exhausted === false, normal.budget().reason);
}

/* ⑩ 工具真的注册给模型了吗（不是"实现了"而已） */
{
  const { createPlanTools } = await import('../packages/agent-runtime/dist/plan-tools.js');
  const ws = join(dir, '..', 'tree-reg-' + Math.random().toString(36).slice(2, 8));
  mkdirSync(ws, { recursive: true });
  const tools = createPlanTools(ws, 'sess_reg');
  const names = tools.definitions.map((d) => d.name);
  const want = ['tree_create', 'tree_add', 'tree_update', 'tree_get', 'tree_ask', 'tree_report'];
  check('【关键】六个 tree_* 都在模型可见的工具表里（definitions 快照之后注册就等于没有）',
    want.every((n) => names.includes(n)),
    `tool count=${names.length}, missing=${want.filter((n) => !names.includes(n)).join(',') || 'none'}`);

  /* 端到端：建树 → 省略 id 提问 → 渲染里能看见目标本身 */
  await tools.execute('tree_create', { title: '判据树', subtasks: ['第一步'] });
  const reply = await tools.execute('tree_ask', { text: '选哪个？', options: ['A', 'B'], recommend: 'A', reversible: true });
  check('tree_ask 省略 id 也能用，回执写的是节点 id 而不是 undefined',
    /节点 n\d+/.test(reply) && !reply.includes('undefined'), reply.split('\n')[0]);
  const shown = await tools.execute('tree_get', {});
  check('渲染里有目标节点（walk(rootId) 只列子节点，根要单独打）',
    /\[.\] n1 判据树/.test(shown), shown.split('\n').slice(0, 3).join(' | '));
}

/* ⑪ 自动续跑：会继续，但只在真的走得动时继续 */
{
  const now = () => Date.now();

  const a = new TaskTreeStore(dir, 'auto_a');
  a.create('把 A 做完', undefined, ['第一步', '第二步']);
  const d1 = treeAutopilot(a, { turnStartedAt: now() - 1000, reply: '我先做第一步' });
  check('【关键】还有节点没做完 → 自动继续（不是停下来等人）', d1.proceed === true, d1.reason ?? '');
  check('nudge 写明「不要停下来等我确认」', /不要停下来等我/.test(d1.nudge ?? ''), (d1.nudge ?? '').slice(0, 70));
  check('nudge 写明出口是 tree_report', /tree_report/.test(d1.nudge ?? ''), 'ok');

  const b = new TaskTreeStore(dir, 'auto_b');
  b.create('做完了', undefined, ['唯一一步']);
  for (const n of b.get().nodes) b.update(n.id, { status: 'done' });
  const d2 = treeAutopilot(b, { turnStartedAt: now() - 1000, reply: '好了' });
  check('全部完成 → 停止续跑', d2.proceed === false, d2.reason ?? '');

  const c = new TaskTreeStore(dir, 'auto_c');
  c.create('等你答', undefined, ['一件事']);
  const act = c.get().nodes.find((n) => n.status === 'active') ?? c.get().nodes[0];
  c.ask(act.id, { text: '要不要删？', options: ['删', '不删'], recommend: '不删', blocking: true, reversible: false });
  const d3 = treeAutopilot(c, { turnStartedAt: now() - 1000, reply: '等你' });
  check('blocking 问题未答 → 停止续跑（不空转）', d3.proceed === false, d3.reason ?? '');

  const e = new TaskTreeStore(dir, 'auto_d', { trustModel: false, answerTimeoutMs: 300000, maxMinutes: 0, maxNodeAttempts: 3, maxNodes: 60, backupBeforeAuto: true });
  e.create('预算用尽', undefined, ['一件事']);
  const d4 = treeAutopilot(e, { turnStartedAt: now() - 1000, reply: '继续' });
  check('预算到顶 → 停止续跑', d4.proceed === false, d4.reason ?? '');
  check('理由里点明该 tree_report 了', /tree_report/.test(d4.reason ?? ''), d4.reason ?? '');

  const f = new TaskTreeStore(dir, 'auto_e');
  f.create('昨天的树', undefined, ['一件事']);
  const d5 = treeAutopilot(f, { turnStartedAt: now() + 60_000, reply: '聊点别的' });
  check('这一轮没碰过的树不会被自动续跑（旧树不是常备指令）', d5.proceed === false, d5.reason ?? '');

  const g = new TaskTreeStore(dir, 'auto_f');
  g.create('已收口', undefined, ['一件事']);
  g.recordReport('success', '收到这里');
  const d6 = treeAutopilot(g, { turnStartedAt: now() - 1000, reply: '完了' });
  check('已经 tree_report 过的树不再续跑', d6.proceed === false, d6.reason ?? '');
}

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项 FAIL` : '\n全部 PASS');
process.exit(failed ? 1 : 0);
