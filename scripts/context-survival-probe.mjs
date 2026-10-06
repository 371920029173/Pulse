/*
 * 压缩存活探针：压过一次之后，**早期埋下的事实还在不在**？
 *
 * 为什么单独一个探针、而不是评测任务：触发一次压缩需要"历史真的越过阈值"，而这件事靠对话一轮轮长
 * 起来非常不可靠 —— 实测在 19k 窗口下，预算租借会把工具结果掐到 1.6k 字符，历史于是涨不起来，
 * 三次里只有一次真的压到（自证判据 contextCompacted 当场抓出来了）。探针里直接把历史**塞进去**，
 * 触发就是确定的。
 *
 *   node scripts/context-survival-probe.mjs              # 现状（模型摘要）
 *   node scripts/context-survival-probe.mjs --appendix   # 模型摘要 + 机械摘录（双保险）
 *   node scripts/context-survival-probe.mjs --repeat 3
 *
 * 花钱（真端点：一次摘要 + 一次回答，约 50k token），所以**故意不进 check:offline**。
 * 它回答的是一个测量问题（存活率），不是一个可以离线钉死的性质。
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../packages/shared/dist/index.js';
import { KBStore, GroupKBEngine } from '../packages/kb/dist/index.js';
import { Agent } from '../packages/agent-runtime/dist/index.js';

const args = process.argv.slice(2);
const useAppendix = args.includes('--appendix');
const repeatIdx = args.indexOf('--repeat');
const repeat = repeatIdx >= 0 ? Math.max(1, Number(args[repeatIdx + 1]) || 1) : 1;

/*
 * 8 条事实，**分散埋**在填充里：第 1 条在最前面（最深处，必然被折叠），最后一条在压缩点附近。
 * 为什么不是 1 条：单条事实在 3 次里 3 次都活了下来 —— 它测不出差别。存活率才测得出。
 */
const FACTS = Array.from({ length: 8 }, (_, i) => ({ key: `KEY-${i + 1}`, value: `ALPHA-${1111 * (i + 1)}` }));
/*
 * 题目明确**不要调用工具**：要量的是"摘要里保住了什么"，而工具会把这件事盖住 —— 第一版里它找不到
 * 那几个 KEY 就一轮轮查空知识库，还没开口就被预算停掉，量到的其实是"预算停了它"。
 */
const QUESTION = '不要调用任何工具。只根据你现在看到的内容回答：把这次会话里我让你记住的 '
  + FACTS.map((f) => f.key).join('、') + ' 全部列出来，格式是 KEY-n=值，一行一个。不要解释。';

/** 一段"事实分散埋在填充里"的历史。填充的存在是为了把事实推过压缩点。 */
function seedHistory() {
  const out = [];
  for (let i = 0; i < 16; i++) {
    const fact = FACTS[Math.floor(i / 2)];
    if (fact) {
      out.push({ role: 'user', content: `记住这一条：${fact.key} 是 ${fact.value}。只回复 ok。` });
      out.push({ role: 'assistant', content: 'ok' });
    }
    out.push({ role: 'user', content: `这是第 ${i} 段无关的填充材料：` + '填充内容。'.repeat(600) });
    out.push({ role: 'assistant', content: `收到第 ${i} 段。` });
  }
  return out;
}

if (useAppendix) process.env.SHE_DIGEST_APPENDIX = '1';

const cfg = loadConfig();
// 小窗口：固定开销约 13k token，而塞进去的历史约 35k token —— 下一次请求必定越过阈值。
/*
 * 30k 窗口：固定开销约 16.4k、塞进去的历史约 12k ⇒ 阈值 24k 一定越过（40k 时只是"有时"越过，
 * 实测有一半没压到 —— 那几次量到的是空的）。
 */
cfg.llm.contextWindow = 30_000;
cfg.automationMode = false;   // 探针不跑自动化那一套
cfg.sandbox.denyDestructiveByDefault = false;

const rows = [];
for (let run = 1; run <= repeat; run++) {
  const dir = mkdtempSync(join(tmpdir(), 'she-survival-'));
  mkdirSync(join(dir, '.she'), { recursive: true });
  /*
   * **把工作区指到这个临时目录**：会话状态（compaction.json、落盘的原文）是按 workspace.root 落的，
   * 不指过来的话每一次探针运行都会去读**上一次留下的那份冻结摘要**（日志里会写"复用已冻结的摘要"），
   * 于是实验量的是陈摘要 —— 第一版就是这么骗过自己的。
   */
  cfg.workspace.root = dir;
  const store = new KBStore(join(dir, '.she', 'kb.sqlite'));
  const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(dir, '.she', 'kb.sqlite') });
  /*
   * **不给沙箱工具**：见文件头。给了它就会去搜，搜到的是"工作区里有没有"，而不是"摘要记住了没有"。
   * 只留 Agent 自己的内部工具（计划 / 备忘 / 预检 / 错题本 / 知识库）。
   */
  const tools = { definitions: [], execute: async () => '' };
  // 每轮的上限：轮次与墙钟。打转就停，不让探针跑成一场马拉松。
  cfg.budget = { enabled: true, maxToolRounds: 4, maxToolCalls: 8, maxTokens: 0, maxSeconds: 150 };
  const agent = new Agent(cfg, engine, tools, 'sess-survival');

  agent.setHistory(seedHistory());
  const before = agent.getContextStatus();
  const reply = await agent.chat(QUESTION);
  const after = agent.getContextStatus();

  const compactionFile = join(dir, '.she', 'sessions', 'sess-survival', 'compaction.json');
  const record = existsSync(compactionFile) ? JSON.parse(readFileSync(compactionFile, 'utf8')) : null;
  rows.push({
    轮次: run,
    模式: useAppendix ? '摘要 + 机械摘录' : '只模型摘要',
    压过: after.compacted,
    覆盖条数: record?.covered ?? 0,
    摘要字符: record?.digest?.length ?? 0,
    摘要来源: record?.source ?? null,
    '压前/压后 token': record ? `${record.beforeTokens} → ${record.afterTokens}` : null,
    锚点数: record?.anchors?.length ?? 0,
    摘要: String(record?.digest ?? '').slice(0, 400),
    答复: String(reply.content ?? '').trim().slice(0, 200),
    摘要里命中的事实: FACTS.filter((f) => String(record?.digest ?? '').includes(f.value)).map((f) => f.key),
    答复里命中的事实: FACTS.filter((f) => String(reply.content ?? '').includes(f.value)).map((f) => f.key),
    历史条数: { 前: before.compaction?.covered ?? 0, 后: agent.getHistory().length },
  });
  await agent.dispose();
  try { store.close?.(); } catch { /* 关不关都不影响结论 */ }
}

console.log(JSON.stringify(rows, null, 2));
const compacted = rows.filter((r) => r.压过).length;
const survived = rows.map((r) => FACTS.filter((f) => r.答复.includes(f.value)).length);
const inDigest = rows.map((r) => FACTS.filter((f) => r.摘要.includes(f.value)).length);
const avg = (xs) => xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
console.log(`\n模式：${rows[0].模式} · 重复 ${rows.length} 次 · 埋了 ${FACTS.length} 条`);
console.log(`真压过：${compacted}/${rows.length}（没压过的那几次什么都没测）`);
console.log(`事实出现在摘要里：平均 ${avg(inDigest).toFixed(1)}/${FACTS.length}`);
console.log(`**事实在答复里活下来：平均 ${avg(survived).toFixed(1)}/${FACTS.length}**（逐次：${survived.join(' / ')}）`);
