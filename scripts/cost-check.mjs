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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
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
import { pinHostSandbox } from './lib/host-sandbox.mjs';

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
  // The reply echoes only the step just changed, with its note clipped: the model wrote it one call ago.
  check(
    '【关键】本次改动的那条备注在',
    last.includes(noteOf(12).slice(0, 30)),
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
  check('每次回复都带进度（回复仍能说明计划走到哪）', replies.every((r) => /12/.test(r) && /下一步: /.test(r)), last);
  check('「下一步」仍然给出（收口时说明已收口）', /下一步: /.test(last), last);

  // The full table lives in plan_list / plan_get, not in every update reply.
  const listed = await tools.execute('plan_list', {});
  const stepLines = listed.split('\n').filter((l) => /^\s*\[[ x>!-]\]\s+s\d+\s/.test(l));
  check('【关键】12 步一条不少，状态照印（在 plan_list 里）', stepLines.length === 12, `got ${stepLines.length}`);
  check('其中已完成 12 步都标成 [x]', stepLines.every((l) => l.includes('[x]')), stepLines.join('\n'));

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
    '但也没有短成一条错误信息（回复仍说明改了哪步、下一步是什么）',
    trimmedTotal > updates * 40,
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
  // limit: 30 so every hit is listed; the default-top-5 behaviour is checked separately below.
  const plain = await kbTools.execute('kb_query', { query: MARKER, limit: 30 });
  const full = await kbTools.execute('kb_query', { query: MARKER, full: true, limit: 30 });
  const byDefault = await kbTools.execute('kb_query', { query: MARKER });

  kbReturned = viaEngine.nodes.length;
  kbLong = viaEngine.nodes.filter((n) => n.content.length > 200).length;
  defaultChars = plain.length;
  fullChars = full.length;
  contentChars = viaEngine.nodes.reduce((n, x) => n + x.content.length, 0);

  check('前提：这次查询真的命中了多条（否则下面的对照没意义）', kbReturned >= 3, `命中 ${kbReturned} 条`);
  check('前提：其中确实有长文（摘要有东西可摘）', kbLong >= 1, `长文 ${kbLong} 条`);
  if (kbReturned > 5) {
    check('默认只列前 5 条，并说明还有多少没列', /另有 \d+ 条未列出/.test(byDefault), byDefault.slice(-200));
  }

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

console.log('\n5. 缓存前缀：换一个工作区还能命中多少，以及每轮重算的块会不会毁掉它');
{
  const { Agent } = await import('../packages/agent-runtime/dist/index.js');
  const { SandboxShell, createTools } = await import('../packages/sandbox/dist/index.js');

  const build = (root, sessionId) => {
    const c = loadConfig(PROJECT_ROOT);
    c.workspace.root = root;
    c.automationMode = true;
    c.sandbox.allowAllCommands = true;
    const s = new KBStore(join(root, '.she', 'kb.sqlite'));
    const e = new GroupKBEngine(s, { ...c.kb, dbPath: join(root, '.she', 'kb.sqlite') });
    const t = createTools(new SandboxShell(root, pinHostSandbox(c.sandbox)), root, {
      allowAllCommands: true,
      kbDbPath: join(root, '.she', 'kb.sqlite'),
    });
    return { agent: new Agent(c, e, t, sessionId, { subagentRunner: { run: async () => ({}) } }), store: s };
  };

  /** The ledger the calibration verdict is computed from: over-claimed, mostly failed. */
  const writeLedger = (root, count, claimed = 0.9) => {
    mkdirSync(join(root, '.she', 'reflection'), { recursive: true });
    writeFileSync(join(root, '.she', 'reflection', 'confidence.json'), JSON.stringify({
      samples: Array.from({ length: count }, (_, i) => ({
        at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        claimed, attempted: 4, succeeded: 1,
      })),
    }), 'utf8');
  };
  const writeSessionSamples = (root, sessionId, topics) => {
    const d = join(root, '.she', 'sessions', sessionId);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'confidence.json'), JSON.stringify({
      samples: topics.map((topic, i) => ({
        at: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString(),
        claimed: 0.9, attempted: 4, succeeded: 1, topic,
      })),
    }), 'utf8');
  };

  const sameWorkspace = join(dir, 'prefix-same');
  mkdirSync(sameWorkspace, { recursive: true });

  /*
   * (a) 同一个工作区、同一个会话，两轮之间把「证据」整个换掉：系统消息必须逐字节不变。
   *
   * 这不是"顺便看一眼"：这块排在系统消息末尾，而工具表按接口的序列化顺序排在消息之后，所以
   * 它一变，**整段历史 + 整张工具表**都落在缓存断点之后。实测（deepseek-flash，~19.5k 字符历史）
   * 是 94% → 37%，也就是这一句每轮要重付掉大半条请求。
   */
  writeLedger(sameWorkspace, 4);
  writeSessionSamples(sameWorkspace, 'sess-prefix', ['检索', '检索', '检索']);
  const first = build(sameWorkspace, 'sess-prefix');
  const seen = [];
  first.agent.provider = {
    name: 'stub',
    async chat(messages) {
      seen.push(String(messages[0].content));
      return { role: 'assistant', content: 'ok' };
    },
  };
  await first.agent.chat('one');
  const systemTurn1 = seen[0] ?? '';
  const hasBlock = /Self-Review — Your Calibration/.test(systemTurn1);
  check('有证据时，自评块确实进了系统消息（否则下面的不变量是空的）', hasBlock,
    `系统消息 ${systemTurn1.length} 字符里没有找到该块`);
  const blockAt = systemTurn1.indexOf('## Self-Review — Your Calibration');
  const blockChars = blockAt < 0 ? 0 : systemTurn1.length - blockAt;
  check('固定开销的读数把它算进去了（少算就等于把回归藏起来）',
    first.agent.getSystemPromptText() === systemTurn1,
    `getSystemPromptText() ${first.agent.getSystemPromptText().length} vs 实际发送 ${systemTurn1.length}`);

  // 换掉全部证据，连领域列表一起。重建的话这一轮就会短一截 —— 那正是每轮重算的代价。
  rmSync(join(sameWorkspace, '.she', 'reflection', 'confidence.json'));
  writeSessionSamples(sameWorkspace, 'sess-prefix', ['排版', '排版', '排版']);
  writeLedger(sameWorkspace, 40, 0.99);
  await first.agent.chat('two');
  const systemTurn2 = seen[1] ?? '';
  check('【关键】证据变了、系统消息没变（每轮重算 = 每轮丢掉整张工具表的命中）',
    systemTurn2 === systemTurn1,
    `第 1 轮 ${systemTurn1.length} 字符 → 第 2 轮 ${systemTurn2.length} 字符；`
    + '差异位置就是缓存断点，断点之后的整段历史与工具表都按全价重算');
  console.log(`        系统消息 ${systemTurn1.length} 字符（自评块 ${blockChars} 字符）在两轮之间逐字节不变`);
  await first.agent.dispose?.();
  first.store.close();

  /*
   * (b) 换工作区：只有工作区路径那一处该变，其余必须能复用。
   *
   * 这是"跨会话还能不能共享前缀"的机械判据。往系统提示词开头塞一个日期、主机名、随机顺序，
   * 都会让这个比例掉下来 —— 而那样做的代价是每次新会话的第一条请求全价。
   */
  const otherWorkspace = join(dir, 'prefix-other');
  mkdirSync(join(otherWorkspace, '.she'), { recursive: true });
  // The same evidence state as the first agent, so the comparison isolates the WORKSPACE as the
  // only variable. Two agents with different self-review readings differ for a reason that has
  // nothing to do with the workspace, and the check would then be measuring the wrong thing.
  writeLedger(otherWorkspace, 4);
  writeSessionSamples(otherWorkspace, 'sess-prefix', ['检索', '检索', '检索']);
  const second = build(otherWorkspace, 'sess-prefix');
  const a = first.agent.getSystemPromptText();
  const b = second.agent.getSystemPromptText();
  const toolsA = JSON.stringify(first.agent.getToolDefinitions());
  const toolsB = JSON.stringify(second.agent.getToolDefinitions());
  let same = 0;
  while (same < a.length && same < b.length && a[same] === b[same]) same++;
  const reuse = 100 * same / a.length;
  console.log(`        换工作区：系统提示词 ${a.length} → ${b.length} 字符，共同前缀 ${same} 字符（${reuse.toFixed(1)}%）`);
  /*
   * 判据不是"共同前缀够长"，而是**把工作区路径遮掉之后两条必须逐字节相同**。
   *
   * 前者会随提示词长度漂移（自评块一进来，同一个断点的百分比就掉了 2 个点），而且它只说明"断点
   * 靠后"，不说明"断点是工作区路径"。后者说的是准确的那句话：跨工作区唯一会变的就是那一个路径，
   * 所以新会话的第一条请求仍然能复用前面这一段（实测：33 个工具时 25.6k/26.7k 字符，
   * 41 个工具时按比例更多）。往提示词里加一个日期、主机名、或者把工具表按 Map 顺序拼，
   * 都会让这条判断红 —— 而那样做的代价是每次新会话的第一条请求全价。
   */
  const masked = (s, root) => s.split(root).join('<WORKSPACE>');
  const maskedA = masked(a, sameWorkspace);
  const maskedB = masked(b, otherWorkspace);
  let mSame = 0;
  while (mSame < maskedA.length && mSame < maskedB.length && maskedA[mSame] === maskedB[mSame]) mSame++;
  check('【关键】跨工作区只有工作区路径一处不同（遮掉路径后逐字节相同）',
    maskedA === maskedB,
    `遮掉路径后仍不同：A ${maskedA.length} 字符 vs B ${maskedB.length} 字符，`
    + `首个差异在第 ${mSame} 字符：A ${JSON.stringify(maskedA.slice(Math.max(0, mSame - 50), mSame + 50))} / `
    + `B ${JSON.stringify(maskedB.slice(Math.max(0, mSame - 50), mSame + 50))}`);
  check('共同前缀 ≥90%（换工作区时前面的这一段仍然命中）', reuse >= 90,
    `共同前缀只有 ${reuse.toFixed(1)}%`);
  check('工具表逐字节一致（顺序不确定 = 整张表重新计费；实测换序丢掉 3456 命中 tokens）',
    toolsA === toolsB);
  console.log(`        工具表 ${first.agent.getToolDefinitions().length} 个工具 ${toolsA.length} 字符 ≈ ${Math.round(toolsA.length / 3.47)} tokens`
    + '（按接口的序列化顺序排在消息之后，所以消息里任何一处变动都会把它一起推到 miss 桶）');
  await first.agent.dispose?.();
  await second.agent.dispose?.();
  first.store.close();
  second.store.close();
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * 6. 一条工具结果不是付一次，是每次请求都付
 *
 * 实测（2026-10-03，真实自评会话 `sess_a1b2c3d4e5f6`）：一次 `shell_wait` 返回了 732,633 字符，
 * 占那一整份记录 964,280 字符的 76%；那一轮 35 次请求，prompt 9,318,458 tokens。缓存命中率 96%
 * —— 命中率从来不是问题，是上下文本身就大，而且每一轮都重发一遍。
 *
 * 这一节驱动真实 Agent，钉住四件事：进上下文的有界、首尾是原文、省略量报的是真数字、去路具体；
 * 以及**一条不裁**：预算内的结果逐字节原样通过（否则这个"预算"就是一个到处丢数据的 bug）。
 * ─────────────────────────────────────────────────────────────────────────────
 */
console.log('\n6. 工具结果的上下文预算：一条结果每一轮都要重付');
{
  const { Agent, TOOL_RESULT_CONTEXT_CHARS } = await import('../packages/agent-runtime/dist/index.js');

  const root = join(dir, 'budget');
  mkdirSync(join(root, '.she'), { recursive: true });

  /** What the tool really returned, so the section can prove it was over budget rather than assume it. */
  const returned = new Map();
  const huge = (chunks) => '> pnpm check:offline\n\n'
    + 'x'.repeat(chunks)
    + '\n\n=== ALL CHECKS PASSED (52 steps, 616.7s) ===\n';

  const defs = ['shell', 'fs_read', 'agreeable'].map((name) => ({
    name,
    description: 'stub',
    parameters: { type: 'object', properties: {}, required: [] },
  }));
  const execute = async (name) => {
    // 200,000 characters: the same order as the single result that caused this.
    if (name === 'fs_read') { const t = huge(200_000); returned.set(name, t); return t; }
    // Deliberately far under the budget, for the "not a blanket truncator" assertion.
    if (name === 'agreeable') { const t = 'stdout:\nPASS 15/15\nexit code: 0'; returned.set(name, t); return t; }
    const t = huge(200_000); returned.set(name, t); return t;
  };

  const c = loadConfig(PROJECT_ROOT);
  c.workspace.root = root;
  c.llm = { ...c.llm, model: 'stub' };
  c.sandbox = { ...c.sandbox, allowAllCommands: true };
  const store = new KBStore(join(root, '.she', 'kb.sqlite'));
  const engine = new GroupKBEngine(store, { ...c.kb, dbPath: join(root, '.she', 'kb.sqlite') });
  const agent = new Agent(c, engine, { definitions: defs, execute }, 'sess-budget', {
    subagentRunner: { run: async () => ({}) },
  });

  const sent = [];
  let step = 0;
  const scripts = [
    [{ name: 'shell' }, { name: 'fs_read' }, { name: 'agreeable' }],
  ];
  agent.provider = {
    name: 'stub',
    async chat(messages) {
      sent.push(messages.map((m) => ({ ...m })));
      const calls = scripts[step];
      if (!calls) return { role: 'assistant', content: 'done' };
      step++;
      return {
        role: 'assistant',
        content: '',
        tool_calls: calls.map((x, i) => ({
          id: `call_${step}_${i}`,
          type: 'function',
          function: { name: x.name, arguments: '{}' },
        })),
      };
    },
  };

  await agent.chat('跑一个会打印几十万字符的命令', () => {});

  const toolMsgs = agent.getHistory().filter((m) => m.role === 'tool');
  const byCall = new Map(toolMsgs.map((m) => [String(m.tool_call_id), String(m.content)]));
  const shellStored = byCall.get('call_1_0') ?? '';
  const readStored = byCall.get('call_1_1') ?? '';
  const smallStored = byCall.get('call_1_2') ?? '';

  check('工具真的返回了 20 万字符（否则这一节测的是空的）',
    (returned.get('shell') ?? '').length > 200_000,
    `实际返回 ${(returned.get('shell') ?? '').length} 字符`);

  check('【关键】进上下文的那一条不超过预算',
    shellStored.length > 0 && shellStored.length <= TOOL_RESULT_CONTEXT_CHARS,
    `history 里 ${shellStored.length} 字符，预算 ${TOOL_RESULT_CONTEXT_CHARS}；`
    + `不设预算时它是 ${(returned.get('shell') ?? '').length} 字符`);

  check('开头和结尾都是命令自己的原文',
    shellStored.startsWith('> pnpm check:offline') && /ALL CHECKS PASSED \(52 steps/.test(shellStored),
    shellStored.slice(0, 60) + ' … ' + shellStored.slice(-60));

  check('省略量是真实的：说明里的数字能和实际长度对上',
    /省略了(?:中间)? (\d+) 字符/.test(shellStored)
    && Number(/省略了(?:中间)? (\d+) 字符/.exec(shellStored)[1]) > 0
    && /返回了? 2000\d\d 字符/.test(shellStored),
    (/省略了(?:中间)? \d+ 字符/.exec(shellStored) ?? ['没有找到省略说明'])[0]);

  /*
   * 命令输出的去路是"全文已存到某个文件，用 fs_read 分段读"——不是让模型重跑命令；fs_read 的去路是
   * startLine / endLine 分段读它自己的文件。两句必须不同，且 shell 那句要点名一个真实存在的文件。
   */
  const spilled = (/已存到 (\S+?\.log)/.exec(shellStored) ?? [])[1] ?? '';
  check('去路按工具给，不是一句笼统的"结果太长"',
    /startLine/.test(readStored) && /tool-output\//.test(spilled)
    && (/\[tool-result\] (.+)/.exec(shellStored) ?? [])[1] !== (/\[tool-result\] (.+)/.exec(readStored) ?? [])[1],
    `shell: ${(/\[tool-result\] (.+)/.exec(shellStored) ?? [])[1]}\n        fs_read: ${(/\[tool-result\] (.+)/.exec(readStored) ?? [])[1]}`);

  check('【关键】命令输出的全文真的落盘了，读回来就是工具返回的原文（裁掉的部分没有丢）',
    spilled !== '' && existsSync(join(root, spilled))
    && readFileSync(join(root, spilled), 'utf8').startsWith(returned.get('shell') ?? '\u0000'),
    spilled || '说明里没有落盘路径');

  check('【关键】预算内的结果逐字节原样（这个预算不是见谁都裁）',
    smallStored === 'stdout:\nPASS 15/15\nexit code: 0',
    JSON.stringify(smallStored.slice(0, 120)));

  check('模型收到的和落盘的是同一份（不是存储裁了、请求没裁）',
    sent[sent.length - 1].filter((m) => m.role === 'tool').every((m) => m.content.length <= TOOL_RESULT_CONTEXT_CHARS),
    sent[sent.length - 1].filter((m) => m.role === 'tool').map((m) => m.content.length).join(', '));

  /*
   * 这一节的数字本身，和上面那段注释里的实测对上：省下的是**每一轮**的重复，不是一次性的大小。
   *
   * 35 次请求、其中约 20 次在这条结果之后 —— 一次 732,633 字符（≈21 万 tokens）的结果，
   * 光它一项就是 400 万 tokens 量级。所以判据是"这一条小了多少量级"，而不是"小了百分之几"。
   */
  const rawChars = (returned.get('shell') ?? '').length;
  console.log(`        shell 结果 ${rawChars} 字符 → 进上下文 ${shellStored.length} 字符`
    + `（${(100 * shellStored.length / rawChars).toFixed(1)}%）；`
    + `按 3.47 字符/token，每一个后续请求少付 ≈${Math.round((rawChars - shellStored.length) / 3.47)} tokens`);

  /*
   * 先有记录、后有规则的那一半。
   *
   * 上面断言的是"推进 history 的那一刻"设了预算；但盘上已经存在的会话记录里就存着这种大结果
   * （实测那条 732,633 字符的 `shell_wait`），只在推入时设预算，对它们**一次都不生效** ——
   * 用户恢复那条会话，账单照旧。所以这里用 `setHistory`（恢复会话与显式改历史的入口）直接塞一条
   * 旧写法的大结果进去，看它进**请求**时有没有被压住。
   */
  const oversized = 'x'.repeat(732_633);
  agent.setHistory([
    { role: 'user', content: '继续' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_old', type: 'function', function: { name: 'shell_wait', arguments: '{}' } }],
    },
    { role: 'tool', content: oversized, tool_call_id: 'call_old' },
  ]);
  const before = agent.getHistory();
  await agent.chat('接着看', () => {});
  const lastSent = sent[sent.length - 1] ?? [];
  const sentTools = lastSent.filter((m) => m.role === 'tool');
  check('【关键】恢复出来的旧记录进请求时也被压住（先有记录、后有规则的那一半）',
    sentTools.length > 0 && sentTools.every((m) => m.content.length <= TOOL_RESULT_CONTEXT_CHARS),
    `请求里的工具结果 ${sentTools.map((m) => m.content.length).join(', ')} 字符`);
  check('旧记录的去路也按工具给（工具名从调用它的那条 assistant 消息里认出来）',
    sentTools.some((m) => /shell_wait/.test(m.content)),
    (sentTools[0]?.content ?? '').slice(-200));
  check('【关键】没有为了压住请求而去改盘上的记录（打开一份会话不该改它）',
    before.some((m) => m.role === 'tool' && m.content.length === oversized.length),
    '存下来的那条被就地改短了');

  await agent.dispose?.();
  store.close();
}

removeTempDir(dir);
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}  cost-check`);
process.exit(failures === 0 ? 0 : 1);