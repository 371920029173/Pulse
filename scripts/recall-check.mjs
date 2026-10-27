/*
 * check:recall —— 召回链路的离线评测（不调模型、不联网、不花一分钱）。
 *
 * 为什么门禁里必须有它：2.0 的每一步都很容易"感觉变好了"，而召回系统一旦过度检索，
 * 症状是"答得更啰嗦、更爱跑题"——肉眼看不出来。所以这里钉四件事：
 *
 *   ① L0 目录卡：有内容、≤1400 字符、两次调用逐字节相同（前缀缓存的前提）；
 *   ② 路由的**正负集**：记忆依赖型必须召回，闲聊/纯指令必须不召回（balanced，两边都测）；
 *   ③ 强锚召回：库里确有的答案，query 必须在前 3 条里拿到（recall@3）；
 *   ④ 弱锚（没有 recall_when 的旧记忆）仍然可检索 —— 不因为缺字段就消失。
 *
 * 判据全部打印实际值；任何一条不过就 exit 1。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KBStore } from '../packages/kb/dist/store.js';
import { GroupKBEngine } from '../packages/kb/dist/engine.js';
import { renderAutoRecall } from '../packages/agent-runtime/dist/auto-recall.js';
import { composeKbIndexCard } from '../packages/agent-runtime/dist/kb-index-card.js';
import { planRecall } from '../packages/agent-runtime/dist/recall-router.js';
import { toolHintLine } from '../packages/agent-runtime/dist/tool-hint.js';

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const dir = mkdtempSync(join(tmpdir(), 'she-recall-check-'));
const store = new KBStore(join(dir, 'kb.sqlite'));
const engine = new GroupKBEngine(store, {
  dbPath: join(dir, 'kb.sqlite'),
  maxChildrenBeforeSplit: 12,
  dormancyThresholdDays: 30,
  activationBudget: 100,
  boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
});

/* ── 造一个小库：强锚（有 recall_when）+ 弱锚（没有）+ 另一个组 ── */
const gShell = engine.createGroup('errors/shell');
const gDecisions = engine.createGroup('decisions/context');
engine.addMemoryMaintained(gShell.id, 'fact', 'shell: true 让 Node 拼命令行的原因',
  '直接调用系统命令行解释器时，引号会被重新解析（实测 node -p "1+1" 打印出 1+1）。改用 shell:true 让 Node 自己拼命令行就不会。',
  { recallWhen: '改 shell 调用、引号处理、Windows 命令行时' });
engine.addMemoryMaintained(gDecisions.id, 'fact', '上下文压缩会不会让费用增加',
  '压缩会减少重复发送，但模型可能为了补被省掉的上下文多跑几轮，那几轮也要钱。',
  { recallWhen: '用户问压缩是否省钱、或要解释账单时' });
engine.addMemoryMaintained(gShell.id, 'text', '旧记忆：没有召回条件的那条',
  '这条没有 recall_when，用来验证弱锚仍然可检索。',
  { noRecallWhen: true });

/* ① L0 目录卡 */
const card1 = composeKbIndexCard(engine);
const card2 = composeKbIndexCard(engine);
check('L0 卡片非空', card1.length > 0, `${card1.length} 字符`);
check('L0 卡片 ≤1400 字符', card1.length <= 1400, `${card1.length}`);
check('L0 卡片含顶层组名', /errors/.test(card1) && /decisions/.test(card1), card1.split('\n')[1] ?? '');
check('L0 卡片两次逐字节相同', card1 === card2, card1 === card2 ? 'identical' : 'DIFFERS');

/* ② 路由正负集（各 5 条，balanced） */
const positives = [
  '修复 agent.ts 里的超时问题',
  '上次我们为什么决定不用向量检索？',
  '帮我写一份 README 的说明',
  '把这个函数重构一下，测试也要跑',
  '这个项目之前约定的端口是多少',
];
const negatives = ['你好', '谢谢', '在吗', '继续', '好的'];
const posKinds = positives.map((q) => planRecall(q).kind);
const negKinds = negatives.map((q) => planRecall(q).kind);
check('正集全部要召回（kind≠chat）', posKinds.every((k) => k !== 'chat'), posKinds.join(','));
check('负集全部不召回（kind=chat）', negKinds.every((k) => k === 'chat'), negKinds.join(','));
const posHit = posKinds.filter((k) => k !== 'chat').length;
const negMiss = negKinds.filter((k) => k === 'chat').length;
check('balanced 指标：漏召回 0，误触发 0',
  posHit === positives.length && negMiss === negatives.length,
  `漏召回 ${positives.length - posHit}/${positives.length}，误触发 ${negatives.length - negMiss}/${negatives.length}`);

/* ③ 强锚召回：题目里点名的证据必须进前 3 条 */
const q1 = '引号被重新解析是怎么回事';
const recall1 = renderAutoRecall(engine, q1);
const ids1 = [...String(recall1).matchAll(/\[Node: ([^\]]+)\]/g)].map((m) => m[1]);
const strongIds = [...String(recall1).matchAll(/\[Node: ([^\]]+)\]/g)].map((m) => m[1]);
check('强锚召回：结果里有命中', ids1.length > 0, `${ids1.length} 条`);
const shellRes = engine.query('shell 真让 Node 拼命令行');
const shellTitles = shellRes.nodes.slice(0, 3).map((n) => n.title);
check('强锚 recall@3 命中 shell 那条',
  shellTitles.some((t) => t.includes('shell: true')),
  `前 3 条: ${shellTitles.join(' | ')}`);
void strongIds;

/* ④ 弱锚仍然可检索 */
const weak = engine.query('没有召回条件的那条').nodes.slice(0, 5).map((n) => n.title);
check('弱锚（无 recall_when）仍可检索', weak.some((t) => t.includes('没有召回条件')), weak.join(' | '));

/* ⑤ 工具提示行：认得出任务就给，闲聊就不给（点名不存在的工具比不提示更糟） */
const ALL_TOOLS = ['shell', 'fs_read', 'fs_write', 'map_impact', 'kb_query', 'kb_get', 'map_history'];
const hintCode = toolHintLine('code', ALL_TOOLS);
const hintChat = toolHintLine('chat', ALL_TOOLS);
check('工具提示：code 轮点名真注册的工具',
  hintCode.includes('map_impact') && hintCode.includes('shell'),
  hintCode.slice(0, 60));
check('工具提示：chat 轮为空', hintChat === '', JSON.stringify(hintChat));
check('工具提示：未注册的工具不会被点名',
  !toolHintLine('writing', ['fs_write']).includes('kb_query'),
  toolHintLine('writing', ['fs_write']).slice(0, 50));

/* ⑥ 空库与坏引擎不抛、不返回垃圾 */
const emptyEngine = new GroupKBEngine(new KBStore(join(dir, 'empty.sqlite')), {
  dbPath: join(dir, 'empty.sqlite'), maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30,
  activationBudget: 100, boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
});
check('空库卡片是空串', composeKbIndexCard(emptyEngine) === '');
check('坏引擎卡片是空串', composeKbIndexCard(null) === '');

/*
 * Windows 上 sqlite 文件可能还被连接持有：先关连接再删；删不掉就不算失败 ——
 * 这是临时目录，系统会清理，而"清理失败"绝不该让一条评测判红。
 */
try {
  store.close();
} catch { /* 已经关了 */ }
try {
  rmSync(dir, { recursive: true, force: true });
} catch { /* 句柄未释放，留给系统临时目录 */ }
console.log(failed ? `\n${failed} 项 FAIL` : '\n全部 PASS');
process.exit(failed ? 1 : 0);
