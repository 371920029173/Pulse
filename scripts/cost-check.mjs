/**
 * The two widest pipes out of a measured 230W-token run — offline, no API calls, no ports.
 *
 * A real long task was forensically read back and two tool replies dominated it, both by
 * re-sending the same bytes:
 *
 *   - `plan_update` ran ~15 times, and printed the WHOLE plan with EVERY step's note on each of
 *     them. Fourteen of those fifteen printings were bytes the model had already been given;
 *     the plan file is what holds the notes, so the echo bought nothing.
 *   - `kb_query` ran ~10 times, each activating 8–12 nodes, and returned each node's text whole.
 *     Memories are short (a port, a command, a convention) but an ingested document is not, so a
 *     single query could re-send several thousand characters of prose the model usually only
 *     needs the gist of.
 *
 * The fix trims both, and the risk in a fix like this is entirely in one direction: a cost
 * optimization that drops a note, a memory, or a node id is a data-loss bug wearing a budget's
 * clothes. So this check pins BOTH halves and prints the measured numbers:
 *
 *   - the reply is smaller (measured, and asserted to actually be smaller — not merely claimed);
 *   - everything is still reachable: every step is still listed with its status, every note is
 *     still printed by `plan_list`, every node's title and id still come back, and `full: true`
 *     returns the original text byte-for-byte.
 *
 * The second half is the one that matters. If a future change makes the reply shorter by
 * deleting something, section 1/3 fail rather than the bill looking better.
 */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../packages/shared/dist/index.js';
import { KBStore, GroupKBEngine } from '../packages/kb/dist/index.js';
import {
  createPlanTools,
  renderPlan,
  createKBTools,
} from '../packages/agent-runtime/dist/index.js';
import { removeTempDir } from './lib/temp.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'she-cost-'));
mkdirSync(join(dir, '.she'), { recursive: true });

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 500)}`);
  }
};

const cfg = loadConfig(PROJECT_ROOT);
cfg.workspace.root = dir;

/** A note the length of the ones a real run wrote — that is the payload being repeated. */
const noteOf = (i) =>
  `第 ${i} 步的发现：实测走通了这条路径，命令是 pnpm --filter @she/agent-runtime test，`
  + `退出码 0，覆盖 ${i * 3 + 7} 个用例；顺手记下端口 ${5500 + i} 和一处待办。`;

console.log('1. plan_update 省掉的是「已经印过的备注」，不是步骤');
let trimmedTotal = 0;
let echoedTotal = 0;
let updates = 0;
{
  const tools = createPlanTools(dir, 'sess-cost');
  const steps = Array.from({ length: 12 }, (_, i) => `步骤 ${i + 1}`);
  const created = await tools.execute('plan_create', { title: '成本对照', steps });
  const planId = /plan_[0-9a-f]+/.exec(created)[0];

  const replies = [];
  const counterfactual = [];
  for (let i = 1; i <= 12; i++) {
    const note = noteOf(i);
    const reply = await tools.execute('plan_update', {
      plan_id: planId,
      step_id: `s${i}`,
      status: 'done',
      note,
    });
    replies.push(reply);
    /*
     * What the reply WOULD have been before the trim: the same plan rendered with no filter.
     * Re-read from disk, so this is the real stored plan and not the object the tool returned.
     */
    counterfactual.push(renderPlan(tools.store.get(planId)));
  }
  trimmedTotal = replies.reduce((n, r) => n + r.length, 0);
  echoedTotal = counterfactual.reduce((n, r) => n + r.length, 0);
  updates = replies.length;

  const last = replies[replies.length - 1];
  check(
    '【关键】本次改动的那条备注在',
    last.includes(noteOf(12)),
    last,
  );
  check(
    '【关键】上一次的备注没有重复回显（这才是被省掉的那部分）',
    !last.includes(noteOf(11)),
    last,
  );
  check(
    '对照：同样的调用在旧行为下确实会重印它（证明省的是重复）',
    counterfactual[counterfactual.length - 1].includes(noteOf(11)),
    counterfactual[counterfactual.length - 1],
  );
  /*
   * The plan must still be readable AS a plan: the thing that makes it a checkpoint is the list
   * of steps and where they stand. Trimming that would be trimming information.
   */
  const stepLines = last.split('\n').filter((l) => /^\s*\[[ x>!-]\]\s+s\d+\s/.test(l));
  check('【关键】12 步一条不少，状态照印（省的不是这张表）', stepLines.length === 12, `got ${stepLines.length}`);
  check('其中已完成 12 步都标成 [x]', stepLines.every((l) => l.includes('[x]')), stepLines.join('\n'));
  check('「下一步」仍然给出（收口时说明已收口）', /下一步: /.test(last), last);

  const listed = await tools.execute('plan_list', {});
  const allNotesKept = Array.from({ length: 12 }, (_, i) => i + 1).every((i) => listed.includes(noteOf(i)));
  check('【关键】12 条备注全部还在 plan_list 里（没有任何一条被删）', allNotesKept, listed.slice(0, 400));
  check('盘上的 note 就是原文（不是渲染文本）', (tools.store.get(planId).steps[11].note ?? '').includes('顺手记下端口'), null);
}

console.log('\n2. plan_update 实测数字');
{
  const saved = echoedTotal - trimmedTotal;
  const pct = echoedTotal ? (100 * saved) / echoedTotal : 0;
  console.log(`  12 次更新：旧行为 ${echoedTotal} 字符 → 现在 ${trimmedTotal} 字符（省 ${saved}，${pct.toFixed(0)}%）`);
  console.log(`  单次平均：${Math.round(echoedTotal / updates)} → ${Math.round(trimmedTotal / updates)} 字符`);
  check('确实更短（不是「差不多」）', trimmedTotal < echoedTotal * 0.7, `${trimmedTotal} vs ${echoedTotal}`);
  check(
    '但也没有短成一条错误信息（步骤表还在，回复仍可当计划读）',
    trimmedTotal > updates * 200,
    `avg ${Math.round(trimmedTotal / updates)} 字符/次`,
  );
}

console.log('\n3. kb_query 省掉的是「整篇长文」的重复，不是节点本身');
const MARKER = 'ZZCOSTMARK';
let kbReturned = 0;
let kbLong = 0;
let defaultChars = 0;
let fullChars = 0;
let contentChars = 0;
{
  const store = new KBStore(join(dir, 'kb.sqlite'));
  const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(dir, 'kb.sqlite') });
  const group = engine.createGroup('project/cost');

  /*
   * Both shapes of memory, because they behave differently and only one of them is worth
   * trimming: conventions and commands must arrive COMPLETE (a summary of a port number is
   * useless), documents must not.
   */
  const short = [
    ['端口约定', `${MARKER}：本机服务统一用 5577，UI 用 5173。`],
    ['shell 约定', `${MARKER}：一律 pwsh，不要用 cmd。`],
    ['构建命令', `${MARKER}：pnpm -r build 后再跑门禁。`],
  ];
  const long = Array.from({ length: 6 }, (_, i) => [
    `历史长文 ${i + 1}`,
    `${MARKER} 第 ${i + 1} 篇：`
      + '背景说明，这段是当时 ingest 进去的整篇文档，正常情况下只需要个摘要。'.repeat(40)
      + `第 ${i + 1} 篇的结尾只在原文里出现。`,
  ]);
  for (const [title, content] of [...short, ...long]) {
    engine.addMemory(group.id, 'fact', title, content);
  }

  const kbTools = createKBTools(engine);
  const viaEngine = engine.query(MARKER);
  const plain = await kbTools.execute('kb_query', { query: MARKER });
  const full = await kbTools.execute('kb_query', { query: MARKER, full: true });

  kbReturned = viaEngine.nodes.length;
  kbLong = viaEngine.nodes.filter((n) => n.content.length > 200).length;
  defaultChars = plain.length;
  fullChars = full.length;
  contentChars = viaEngine.nodes.reduce((n, x) => n + x.content.length, 0);

  check('前提：这次查询真的命中了多条（否则下面的对照没意义）', kbReturned >= 3, `命中 ${kbReturned} 条`);
  check('前提：其中确实有长文（摘要有东西可摘）', kbLong >= 1, `长文 ${kbLong} 条`);

  /*
   * The half that must not break. Every node stays visible — title AND id — because the id is
   * how the agent gets back to it, and a query that hides a hit is a query that loses one.
   */
  for (const node of viaEngine.nodes) {
    check(`节点仍在清单里：${node.title}`, plain.includes(node.title) && plain.includes(node.id), plain.slice(0, 300));
  }

  /*
   * Short memories arrive whole. This is the assertion that stops "summary" from quietly
   * becoming "lossy": a convention that comes back cut in half is a convention the agent will
   * act on wrongly, and it will not know to ask for the rest.
   */
  const shortHits = viaEngine.nodes.filter((n) => n.content.length <= 200);
  for (const node of shortHits) {
    check(`短记忆原样给出（不摘要）：${node.title}`, plain.includes(node.content), node.content);
  }

  /*
   * Long text is cut, and cut transparently: the reply says so and names the way back.
   * A reply that silently shortens a memory is worse than a long one, because the model quotes
   * the summary as if it were the text.
   */
  const longHits = viaEngine.nodes.filter((n) => n.content.length > 200);
  for (const node of longHits) {
    const head = node.content.slice(0, 120);
    const tail = node.content.slice(-30);
    check(`长文只给开头：${node.title}`, plain.includes(head) && !plain.includes(tail), null);
  }
  if (longHits.length) {
    check('截断了就说出来（明写「摘要」）', /摘要/.test(plain), plain.slice(-260));
    check('并给出取回原文的办法（full=true）', /full=true/.test(plain), plain.slice(-260));
  }

  /*
   * The recovery path, byte for byte. `full: true` has to return the stored text EXACTLY —
   * "close to the original" would make this a lossy store with extra steps.
   */
  for (const node of viaEngine.nodes) {
    check(`【关键】full=true 逐字还原：${node.title}`, full.includes(node.content), node.content.slice(0, 200));
  }
  if (longHits.length) {
    const lastLong = longHits[longHits.length - 1];
    check(
      '【关键】长文的结尾在 full=true 里（摘要里没有的东西没丢）',
      full.includes(lastLong.content.slice(-30)),
      lastLong.content.slice(-60),
    );
    check('已经给了全文就不再提示展开（不制造第二次调用）', !/full=true/.test(full), full.slice(-260));
  }

  store.close();
}

console.log('\n4. kb_query 实测数字');
{
  const saved = fullChars - defaultChars;
  const pct = fullChars ? (100 * saved) / fullChars : 0;
  console.log(`  命中 ${kbReturned} 条（长文 ${kbLong} 条），正文合计 ${contentChars} 字符`);
  console.log(`  同一次查询：默认 ${defaultChars} 字符 → full=true ${fullChars} 字符（默认省 ${saved}，${pct.toFixed(0)}%）`);
  check('默认返回确实比全文短', defaultChars < fullChars, `${defaultChars} vs ${fullChars}`);
  check(
    '默认至少要真的砍掉一截（砍不动说明摘要没生效）',
    kbLong === 0 || defaultChars < contentChars,
    `默认 ${defaultChars} vs 正文 ${contentChars}`,
  );
}

removeTempDir(dir);
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}  cost-check`);
process.exit(failures === 0 ? 0 : 1);
