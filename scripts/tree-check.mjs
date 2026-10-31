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
import { TaskTreeStore, DEFAULT_TREE_SETTINGS } from '../packages/agent-runtime/dist/task-tree.js';

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

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项 FAIL` : '\n全部 PASS');
process.exit(failed ? 1 : 0);
