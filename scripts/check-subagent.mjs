/**
 * Verify subagent delegation wiring — offline, no API calls.
 *
 * The two things that must hold:
 *   1. A parent agent HAS `task_spawn`.
 *   2. A CHILD agent does NOT — and also lacks the tools that assume a human is
 *      present or that mutate state the parent owns.
 *
 * Recursion here would be unbounded and multiplicative in cost, so it is
 * enforced structurally (the child is built without a runner) rather than by a
 * runtime check that could be bypassed.
 */
import { loadConfig } from '../packages/shared/dist/index.js';
import { KBStore, GroupKBEngine } from '../packages/kb/dist/index.js';
import { SandboxShell, createTools } from '../packages/sandbox/dist/index.js';
import { Agent } from '../packages/agent-runtime/dist/index.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { removeTempDir } from './lib/temp.mjs';
import { pinHostSandbox } from './lib/host-sandbox.mjs';

const dir = mkdtempSync(join(tmpdir(), 'she-subagent-'));
// Derive the project root from this file's location — never a literal path, so
// the check runs from any clone on any platform.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(PROJECT_ROOT);
cfg.workspace.root = dir;

const store = new KBStore(join(dir, 'kb.sqlite'));
const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(dir, 'kb.sqlite') });
const shell = new SandboxShell(dir, pinHostSandbox(cfg.sandbox));
const tools = createTools(shell, dir, { allowAllCommands: true });

// Agent exposes its tool list through the request payload it would send; reach
// the same array the provider receives by calling a turn-less accessor if
// present, else introspect the private field (test-only).
const toolNames = (a) => {
  const defs = a.allToolDefs ?? [];
  return defs.map((d) => d.name).sort();
};

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ── parent ──────────────────────────────────────────────────────────────────
/*
 * A session id, because a real parent always has one.
 *
 * 2026-09-27 起 `plan_*` / `preflight_*` / `memo_*` 是**会话级**工具（它们的文件按会话存），所以没有会话
 * 的 agent 不再注册它们。这个检查原本用 `null` 造父级，于是"父级有这些工具"的前提没了 —— 那不是产品
 * 形态：服务端的每个 agent 都绑着一个会话，只有只读状态路由会造无会话的 agent，而那种 agent 从不跑回合。
 */
const parentSession = 'sess-subagent-check';
const parentRunner = { run: async () => ({ description: 'x', ok: true, result: 'ok' }) };
const parent = new Agent(cfg, engine, tools, parentSession, { subagentRunner: parentRunner });
const parentTools = toolNames(parent);

record('父智能体有 task_spawn', parentTools.includes('task_spawn'), `${parentTools.length} 个工具`);
record('父智能体有 ask_user', parentTools.includes('ask_user'), '');
record('父级有会话级工具（计划/预检/备忘）', 
  parentTools.some((n) => n.startsWith('plan_')) && parentTools.includes('preflight_record') && parentTools.some((n) => n.startsWith('memo_')),
  `${parentTools.length} 个工具`);

// ── child ───────────────────────────────────────────────────────────────────
const child = new Agent(cfg, engine, tools, 'sess-subagent-check-child', { isSubagent: true });
const childTools = toolNames(child);

record('子智能体没有 task_spawn（无法递归）', !childTools.includes('task_spawn'), `${childTools.length} 个工具`);
record('子智能体没有 ask_user（够不到用户）', !childTools.includes('ask_user'), '');
record('子智能体没有 plan_*（父级拥有计划）', !childTools.some((n) => n.startsWith('plan_')), '');
record('子智能体没有 memo_*', !childTools.some((n) => n.startsWith('memo_')), '');
record('子智能体没有 report_*', !childTools.some((n) => n.startsWith('report_')), '');
record('子智能体没有 kb_ingest_*', !childTools.some((n) => n.startsWith('kb_ingest_')), '');

// ── child must still be able to DO work ─────────────────────────────────────
const useful = ['fs_read', 'fs_write', 'fs_list', 'shell', 'kb_query', 'grep'];
const missing = useful.filter((t) => !childTools.includes(t));
record('子智能体保留干活的工具', missing.length === 0, missing.length ? `缺少: ${missing.join(', ')}` : '');

// ── 软截止接线（2026-10-01：从"已修好但未复现"变成可验证） ─────────────────
/*
 * 时刻表与措辞有单元测试，端到端链路由 `subagent-wrap-up-e2e.test.ts` 驱动真 Agent 验证。
 * 这里钉的是**接线本身**：服务器必须调那一个函数，而不是内联一份等价的 setTimeout ——
 * 内联一份的话，被测的就是另一个实现，覆盖会退化成"看起来有测试"。
 */
const serverSrc = readFileSync(join(PROJECT_ROOT, 'packages/server/src/index.ts'), 'utf8');
record('服务器用 armSubagentWrapUp 武装软截止（不是内联一份 setTimeout）',
  serverSrc.includes('armSubagentWrapUp(child, budgetMs)'),
  '没有这个调用，端到端用例测的就不是线上跑的那份代码');
record('子任务提前结束时撤销掉提醒',
  serverSrc.includes('disarmWrapUp()'),
  '少了它，短任务会留下一直在跑的定时器');
record('超时恢复的是进度而不是一句"子任务超时"',
  serverSrc.includes('formatTimeoutReport(readChildProgress('),
  '父级拿不到"这 180 秒换来了什么"');
record('不再有内联的 wrap-up 定时器残留',
  !/wrapUpTimers/.test(serverSrc),
  'armSubagentWrapUp 之外还有一份定时器，两处迟早会漂移');

console.log('\n  父智能体工具:', parentTools.join(', '));
console.log('  子智能体工具:', childTools.join(', '));

/* ── 后台派发：不能"刚发出去就算完成"（用户 2026-11-02 报的问题） ── */
{
  const { createSubagentTools } = await import('../packages/agent-runtime/dist/subagent-tools.js');
  const seen = [];
  /*
   * runner 在 background 模式下"立刻返回、其实还在跑" —— 真实运行时就是这种行为。
   * 判据钉的是：这时不该报完成，否则卡片刚发就绿、模型以为活干完了。
   */
  const fakeRunner = {
    async run(req) { return { description: req.description, ok: true, result: "（后台继续跑）", handoff: req.handoff }; },
    status: () => [],
  };
  const bgTools = createSubagentTools(fakeRunner, { onProgress: (e) => seen.push(e) });
  const text = await bgTools.execute("task_spawn", { tasks: [{ description: "后台那件事", prompt: "干点活", background: true }] });
  const phases = seen.map((e) => e.phase);
  record("后台派发不发 done 事件（否则卡片刚发就绿）", !phases.includes("done"), phases.join(","));
  record("后台派发给出仍在跑的读数", phases.includes("heartbeat"), phases.join(","));
  record("回执标成后台运行中而不是完成", /后台运行中/.test(String(text)), String(text).split("\n")[0]);
  record("回执让模型用 task_status 去查（别假设已完成）", /task_status/.test(String(text)), "");
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);

store.close();
removeTempDir(dir);

process.exit(failed.length ? 1 : 0);
