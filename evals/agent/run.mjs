/**
 * End-to-end agent evaluation.
 *
 *   node evals/agent/run.mjs                    # 全部任务
 *   node evals/agent/run.mjs --only fix-bug     # 只跑一个
 *   node evals/agent/run.mjs --repeat 3         # 每个任务跑 3 遍，报告方差
 *   node evals/agent/run.mjs --dry-run          # 只检查任务定义，不调用 API
 *   node evals/agent/run.mjs --json
 *
 * Cost control (the whole point of this harness's shape):
 *   1. ONE script runs every task — no per-task process or discovery overhead.
 *   2. Grading is deterministic (filesystem / string assertions), so scoring
 *      costs ZERO extra API calls. An LLM judge would double the spend.
 *   3. Each task has a wall-clock timeout AND a low tool-round cap, so a
 *      misbehaving run cannot burn the budget.
 *   4. Token usage per task is printed, so the cost of an eval run is visible.
 *   5. `--repeat` is opt-in, because it multiplies the bill by exactly its value.
 *
 * A single sample cannot say whether a failure is a regression or luck, which is
 * why the report ends with "先重跑确认" — `--repeat N` is the answer to that,
 * and evals/lib/variance.mjs is what turns the samples into a verdict.
 *
 * Offline parts (fixtures, grading, --dry-run) never touch the network.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

import { loadConfig } from '../../packages/shared/dist/index.js';
import { KBStore, GroupKBEngine } from '../../packages/kb/dist/index.js';
import { SandboxShell, createTools } from '../../packages/sandbox/dist/index.js';
import { Agent } from '../../packages/agent-runtime/dist/index.js';
import { summarize, formatReport } from '../lib/variance.mjs';
import { loadTasks, validateTasks, checksOf, turnCount, AGENT_CHECKS } from '../lib/tasks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dryRun = args.includes('--dry-run');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const repeatIdx = args.indexOf('--repeat');
const repeatArg = repeatIdx >= 0 ? args[repeatIdx + 1] : process.env.SHE_AGENT_REPEAT;

// Bound a single task so a runaway loop cannot spend without limit.
const TASK_TIMEOUT_MS = Number(process.env.SHE_EVAL_TIMEOUT_MS) || 150_000;
process.env.SHE_MAX_TOOL_ROUNDS = process.env.SHE_MAX_TOOL_ROUNDS || '10';

/**
 * How many times to run the whole selection.
 *
 * One sample cannot separate a regression from a flaky task — see evals/lib/variance.mjs. More
 * samples cost more API calls, so the default stays 1 and the repeat is opt-in rather than a
 * silently multiplied bill.
 */
const REPEATS = Math.max(1, Math.min(20, Number(repeatArg) || 1));

const THRESHOLD = Number(process.env.SHE_AGENT_THRESHOLD ?? 0.8);

const tasks = loadTasks(join(HERE, 'tasks.json'));
const selected = only ? tasks.filter((t) => t.id === only) : tasks;
if (selected.length === 0) {
  console.error(`没有匹配的任务: ${only}`);
  process.exit(1);
}

if (dryRun) {
  // `validateTasks` is shared with the verification harness and with scripts/evals-check.mjs, so
  // there is exactly one definition of what a well-formed task is.
  const problems = validateTasks(selected, { knownChecks: AGENT_CHECKS });
  console.log(`\nAgent 评测任务检查：${selected.length} 个任务（dry run，不调用任何 API）\n`);
  for (const t of selected) {
    console.log(`  ${t.id.padEnd(30)} ${String(turnCount(t)).padStart(2)} 轮   ${checksOf(t).map((c) => c.type).join('+')}`);
  }
  if (problems.length) {
    console.log(`\n✗ ${problems.length} 个问题：`);
    for (const p of problems) console.log(`    ${p}`);
    process.exit(1);
  }
  console.log(`\n✓ 任务定义自洽（重跑次数 ${REPEATS}，判分不调用 LLM）`);
  process.exit(0);
}

// ── grading ─────────────────────────────────────────────────────────────────
/** `fs_read ×2, grep ×1` — what ran, in order, for a failure message a human can act on. */
function toolSummary(toolsUsed) {
  if (toolsUsed.length === 0) return '一次工具调用都没有';
  const counts = new Map();
  for (const t of toolsUsed) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

/**
 * Grade with deterministic assertions only.
 *
 * `usage` is passed in so cost-shaped regressions can be graded too. A greeting
 * once cost 66k prompt tokens because a stale plan was resumed and 31 shell
 * commands ran; "the answer was fine but it cost 20x too much" is exactly the
 * kind of failure that an outcome-only check cannot see.
 */
function gradeOne(check, ctx) {
  const { workspaceRoot, reply, usage, turnPrompt = [], toolsUsed = [] } = ctx;
  try {
    if (check.type === 'fileContains') {
      const p = join(workspaceRoot, check.path);
      if (!existsSync(p)) return { pass: false, detail: `文件不存在: ${check.path}` };
      const text = readFileSync(p, 'utf8');
      const missing = check.expect.filter((e) => !text.includes(e));
      return missing.length
        ? { pass: false, detail: `缺少内容: ${missing.join(' / ')}` }
        : { pass: true, detail: '' };
    }
    if (check.type === 'commandOutput') {
      const [cmd, ...rest] = check.command.split(' ');
      const out = execFileSync(cmd, rest, {
        cwd: workspaceRoot, encoding: 'utf8', timeout: 20_000, shell: process.platform === 'win32',
      });
      return out.includes(check.expect)
        ? { pass: true, detail: '' }
        : { pass: false, detail: `输出不含 "${check.expect}"，实际: ${out.trim().slice(0, 80)}` };
    }
    if (check.type === 'replyContains') {
      return reply.includes(check.expect)
        ? { pass: true, detail: '' }
        : { pass: false, detail: `回复不含 "${check.expect}"，实际: ${reply.trim().slice(0, 80)}` };
    }
    if (check.type === 'replyLengthBelow') {
      return reply.length <= check.max
        ? { pass: true, detail: '' }
        : { pass: false, detail: `回复过长 (${reply.length} > ${check.max} 字符)，像是没按"只回答"的要求做` };
    }
    if (check.type === 'usageBelow') {
      const actual = check.metric === 'prompt' ? usage.prompt_tokens : usage.total_tokens;
      return actual <= check.max
        ? { pass: true, detail: '' }
        : { pass: false, detail: `${check.metric ?? 'total'} tokens 过多: ${actual} > ${check.max}` };
    }
    if (check.type === 'fileAbsent') {
      return !existsSync(join(workspaceRoot, check.path))
        ? { pass: true, detail: '' }
        : { pass: false, detail: `不该出现的文件却存在: ${check.path}` };
    }
    /*
     * Context growth across a long session.
     *
     * The failure this catches is the one long runs actually die of: nothing breaks in any single
     * turn, the prompt just keeps growing — a plan that is resumed, a history that is re-injected,
     * a tool result that is quoted back in full — until a session that started at 2k tokens is
     * sending 60k, and it gets slower and more expensive every turn until it times out.
     *
     * Comparing the last turn against the first normalises for the task's own size, so the same
     * number works for a small fixture and a large one. The cap is deliberately loose: this is
     * meant to catch an explosion, not normal growth, and a tight bound would make the task flaky.
     */
    if (check.type === 'turnPromptGrowth') {
      const known = turnPrompt.filter((v) => typeof v === 'number');
      const first = known[0];
      const last = known[known.length - 1];
      if (known.length < 2 || first == null) {
        // Not a pass: a check that silently succeeds when it has no data is worse than no check.
        return { pass: false, detail: `取不到每轮 prompt 用量（只有 ${known.length} 轮），无法判断上下文膨胀` };
      }
      const ratio = last / Math.max(1, first);
      return ratio <= check.max
        ? { pass: true, detail: '' }
        : { pass: false, detail: `末轮 prompt ${last} 是首轮 ${first} 的 ${ratio.toFixed(1)} 倍（上限 ${check.max} 倍）` };
    }
    /*
     * Which tools ran — the method, not the result.
     *
     * A task that says "use `task_spawn`, do not read the files yourself" cannot be graded by its
     * output: the file gets written either way. The failure is the path taken, and the only record
     * of the path is the set of calls, so that is what these two read. The detail names the tools
     * that DID run, because "expected task_spawn, got fs_list+grep+fs_read" is the whole diagnosis.
     */
    if (check.type === 'toolCallsAtMost') {
      return toolsUsed.length <= check.max
        ? { pass: true, detail: '' }
        : { pass: false, detail: `工具调用 ${toolsUsed.length} 次 > 上限 ${check.max}（${toolSummary(toolsUsed)}）` };
    }
    if (check.type === 'toolCallsInclude') {
      const names = toolsUsed.map((t) => t.name);
      return names.includes(check.tool)
        ? { pass: true, detail: '' }
        : { pass: false, detail: `没有调用 ${check.tool}（实际调用：${toolSummary(toolsUsed)}）` };
    }
    if (check.type === 'toolCallsExclude') {
      const names = new Set(toolsUsed.map((t) => t.name));
      const seen = check.tools.filter((t) => names.has(t));
      return seen.length === 0
        ? { pass: true, detail: '' }
        : { pass: false, detail: `不该调用的工具被调用了: ${seen.join(', ')}（实际调用：${toolSummary(toolsUsed)}）` };
    }
    return { pass: false, detail: `未知判据类型: ${check.type}` };
  } catch (err) {
    return { pass: false, detail: `判分异常: ${err.message.slice(0, 100)}` };
  }
}

/** A check is either one assertion or an `all` list of them. */
function grade(check, ctx) {  if (Array.isArray(check.all)) {
    const results = check.all.map((c) => gradeOne(c, ctx));
    const failed = results.filter((r) => !r.pass);
    return failed.length
      ? { pass: false, detail: failed.map((f) => f.detail).filter(Boolean).join('; ') }
      : { pass: true, detail: '' };
  }
  return gradeOne(check, ctx);
}

// ── run one task ────────────────────────────────────────────────────────────
async function runTask(task) {
  const dir = join(tmpdir(), `she-eval-${task.id}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(task.fixtures ?? {})) {
    writeFileSync(join(dir, name), content, 'utf8');
  }

  const cfg = loadConfig(ROOT);
  cfg.workspace.root = dir;
  // Keep the eval cheap: short answers, cheap reasoning, no fallback detours.
  cfg.llm.maxTokens = Math.min(cfg.llm.maxTokens, 2048);
  cfg.llm.thinkingLevel = 'low';
  cfg.llm.fallback = undefined;
  cfg.automationMode = true;
  // allowAllCommands so the task does not stall on a confirm ticket mid-eval.
  cfg.sandbox.allowAllCommands = true;
  cfg.sandbox.denyDestructiveByDefault = false;

  const kbDir = join(dir, '.she');
  mkdirSync(kbDir, { recursive: true });
  const store = new KBStore(join(kbDir, 'kb.sqlite'));
  const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(kbDir, 'kb.sqlite') });
  /*
   * Seed memories the task needs to be answerable.
   *
   * Some behaviours can only be tested against a fact the model has never seen: "does it query the
   * KB before answering" is unobservable when the answer is already in the conversation or in a file
   * it can just read — those tasks would pass while doing the opposite of what they claim.
   */
  for (const m of task.kb ?? []) {
    const group = engine.createGroup(m.groupName);
    engine.addMemory(group.id, m.kind ?? 'fact', m.title, m.content);
  }
  const shell = new SandboxShell(dir, cfg.sandbox);
  // Same wiring as the server, so the eval cannot pass while production refuses or vice versa.
  const tools = createTools(shell, dir, { allowAllCommands: true, kbDbPath: join(kbDir, 'kb.sqlite') });
  /** Child agents started by `task_spawn`, disposed with the parent before the workspace is deleted. */
  const children = [];
  /*
   * A delegation-capable parent.
   *
   * `task_spawn` only exists when a runner is injected (see Agent's constructor), and this harness
   * passed none — so the task that exists to prove delegation was grading the parent's own work
   * instead, and passing: `fileContains` cannot tell who read the files. Wired here so the tool is
   * really there and the task can be graded on the path it takes.
   *
   * The child is a plain agent in the same temp workspace: no worktree, no session bookkeeping.
   * Worktree isolation and the child/orphan rules are covered offline by `check:isolation`, which
   * can assert them without an API call; what this harness has to prove is that delegation works
   * end to end against a real model.
   */
  const subagentRunner = {
    async run(req) {
      const childTools = createTools(new SandboxShell(dir, cfg.sandbox), dir, {
        allowAllCommands: true,
        kbDbPath: join(dir, '.she', 'kb.sqlite'),
      });
      const child = new Agent(cfg, engine, childTools, null, { isSubagent: true });
      // Kept so it can be disposed with the parent: a child that started a language server would
      // otherwise hold the temp directory open exactly like the parent does.
      children.push(child);
      const asked = req.isolation === 'worktree' || (req.handoff?.scope?.length ?? 0) > 0;
      const out = await child.chat(req.prompt);
      return {
        description: req.description,
        ok: true,
        result: out?.content ?? '',
        handoff: req.handoff,
        // The eval workspace is not a git repository, so nothing here can be isolated. Said out
        // loud rather than left to look like a successful isolated run.
        isolation: asked
          ? { requested: true, applied: false, note: '评测工作区不是 git 仓库，子任务在共享工作区里跑' }
          : { requested: false, applied: false },
      };
    },
  };
  const agent = new Agent(cfg, engine, tools, null, { subagentRunner });

  /*
   * Record which tools ran, for the two checks that grade the METHOD rather than the result.
   *
   * A callback rather than reading the run trace afterwards: the trace is written to `.she/runs/`
   * under a temp workspace that is deleted at the end of the task, and the trace could be disabled
   * by config — the check would then have no data and, being written as "no tool calls", would pass
   * for the wrong reason.
   */
  const toolsUsed = [];
  agent.setToolObserver((name, ms, failed) => toolsUsed.push({ name, ms, failed }));

  const t0 = Date.now();
  let reply = '';
  let timedOut = false;
  // A task is either one prompt or a sequence of turns against the SAME agent.
  // Multi-turn is what exercises context retention: turn 2 has to know what turn 1
  // did, which is exactly the behaviour that was reported broken.
  const turns = Array.isArray(task.turns) ? task.turns : [task.prompt];
  let turnsDone = 0;
  // Prompt tokens per turn, taken as deltas of the cumulative counter. This is the only place the
  // growth of the context is visible: the total says what the run cost, not whether it was growing.
  const turnPrompt = [];
  let prevPrompt = 0;
  try {
    for (const turn of turns) {
      const out = await Promise.race([
        agent.chat(turn),
        new Promise((r) => setTimeout(() => { timedOut = true; r(null); }, TASK_TIMEOUT_MS)),
      ]);
      if (timedOut) {
        // Real abort, not a no-op: `stop()` cancels the in-flight request so a
        // timed-out task cannot keep consuming tokens in the background.
        try { agent.stop(); } catch { /* ignore */ }
        break;
      }
      const cumulative = agent.getTokenUsage().prompt_tokens ?? 0;
      // A non-positive delta means the counter is not cumulative (or was reset); recorded as
      // unknown rather than as a number that would make the growth check meaningless.
      turnPrompt.push(cumulative - prevPrompt > 0 ? cumulative - prevPrompt : null);
      prevPrompt = Math.max(prevPrompt, cumulative);
      reply = out?.content ?? '';
      turnsDone++;
    }
  } catch (err) {
    reply = `[异常] ${err.message}`;
  }
  const ms = Date.now() - t0;
  const usage = agent.getTokenUsage();

  const g = timedOut
    ? { pass: false, detail: `超时 ${TASK_TIMEOUT_MS}ms（完成 ${turnsDone}/${turns.length} 轮）` }
    : grade(task.check, { workspaceRoot: dir, reply, usage, turnPrompt, toolsUsed });

  /*
   * Shut the language servers down before deleting the workspace.
   *
   * The LSP child process is spawned with this temp directory as its working directory, so Windows
   * refuses to remove it while the process is alive. That is not hypothetical: `rmSync` threw
   * EBUSY on `diagnostics-aware-edit` and took the entire run down with it — the four tasks after it
   * never ran and the variance report was never printed. `dispose()` sends `shutdown` and then kills.
   */
  for (const a of [agent, ...children]) {
    try { await a.dispose(); } catch { /* a stuck server must not fail the task */ }
  }

  const filesLeft = existsSync(dir) ? readdirSync(dir).length : 0;
  store.close();
  /*
   * Best-effort, and deliberately so.
   *
   * A temp directory that cannot be removed is a leak to report, not a reason to lose the results of
   * every task that came after it. Windows also keeps handles for a moment after a process exits, so
   * this retries a few times with a growing delay and then says which directory was left behind
   * instead of throwing.
   */
  let leftBehind = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      leftBehind = null;
      break;
    } catch {
      leftBehind = dir;
      // `dispose()` above sends `shutdown` and kills the server 1.5s later, so the handle can
      // outlive the call that closed it. Up to ~5s of patience, then say what was left behind.
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }
  if (leftBehind) console.log(`    （临时目录删不掉，已留下：${leftBehind}）`);

  return {
    id: task.id,
    pass: g.pass,
    detail: g.detail,
    ms,
    turns: turns.length,
    turnsDone,
    tokens: usage.total_tokens ?? 0,
    promptTokens: usage.prompt_tokens ?? 0,
    cacheHitTokens: usage.cache_hit_tokens ?? 0,
    cacheMissTokens: usage.cache_miss_tokens ?? 0,
    turnPrompt,
    toolCalls: toolsUsed.length,
    toolsUsed: [...new Set(toolsUsed.map((t) => t.name))],
    prompt: turns[0],
    reply: reply.slice(0, 200),
    filesLeft,
    note: task.note,
  };
}

// ── driver ──────────────────────────────────────────────────────────────────
console.log(`\nAgent 评测：${selected.length} 个任务 × ${REPEATS} 遍 = ${selected.length * REPEATS} 次运行`);
console.log(`模型: ${loadConfig(ROOT).llm.model}   单任务超时: ${TASK_TIMEOUT_MS / 1000}s   工具轮次上限: ${process.env.SHE_MAX_TOOL_ROUNDS}`);
console.log('判分方式：文件系统 / 字符串断言（不调用 LLM 判分）');
if (REPEATS > 1) {
  console.log(`注意：每任务跑 ${REPEATS} 遍，API 花费约为单遍的 ${REPEATS} 倍。`);
}
console.log('');

const samples = [];
/*
 * Run every task once per repeat, rather than one task N times in a row.
 *
 * If a run is interrupted — Ctrl-C, a timeout, an exhausted budget — the samples collected so far
 * are spread evenly across tasks instead of covering a handful of them deeply. The summary stays
 * meaningful when it is truncated.
 */
for (let rep = 0; rep < REPEATS; rep++) {
  if (REPEATS > 1) console.log(`第 ${rep + 1}/${REPEATS} 遍`);
  for (const task of selected) {
    process.stdout.write(`  跑 ${task.id} ... `);
    const r = await runTask(task);
    samples.push(r);
    console.log(`${r.pass ? '✓ 通过' : '✗ 失败'}  ${(r.ms / 1000).toFixed(1)}s  ${r.tokens} tokens  工具 ${r.toolCalls} 次${r.pass ? '' : '  — ' + r.detail}`);
  }
}

const summary = summarize(samples, { threshold: THRESHOLD });

const totalPrompt = samples.reduce((a, r) => a + r.promptTokens, 0);
const totalCacheHit = samples.reduce((a, r) => a + (r.cacheHitTokens ?? 0), 0);
const totalCacheMiss = samples.reduce((a, r) => a + (r.cacheMissTokens ?? 0), 0);
const totalTurns = samples.reduce((a, r) => a + (r.turns ?? 1), 0);

if (asJson) {
  console.log(JSON.stringify({
    model: loadConfig(ROOT).llm.model,
    repeats: REPEATS,
    passed: summary.totals.passed,
    total: summary.totals.samples,
    rate: summary.totals.rate,
    ok: summary.ok,
    threshold: THRESHOLD,
    dead: summary.dead.map((t) => t.id),
    flaky: summary.flaky.map((t) => ({ id: t.id, passes: t.passes, runs: t.runs })),
    byTask: summary.byTask.map((t) => ({
      id: t.id,
      runs: t.runs,
      passes: t.passes,
      verdict: t.verdict,
      tokensMean: Math.round(t.tokens.mean),
      tokensSd: Math.round(t.tokens.sd),
      msMean: Math.round(t.ms.mean),
      msSd: Math.round(t.ms.sd),
    })),
    totalPromptTokens: totalPrompt,
    totalCacheHitTokens: totalCacheHit,
    totalCacheMissTokens: totalCacheMiss,
    totalTurns,
    results: samples,
  }, null, 2));
} else {
  console.log('');
  for (const line of formatReport(summary)) console.log(line);
  if (summary.ok && summary.flaky.length) {
    console.log('  达到门槛，但上面标 ± 的任务判定不稳 —— 单次结果不足以说明它们是坏的。');
  }
  if (!summary.ok && summary.dead.length === 0) {
    console.log('  低于门槛但没有「每次都挂」的任务 —— 先按 --repeat 3 重跑，再判断是不是回归。');
  }
  console.log('  提示缓存      ' + totalCacheHit + ' 命中 / ' + totalCacheMiss + ' 未命中'
    + '  → ' + Math.round((totalCacheHit / Math.max(1, totalCacheHit + totalCacheMiss)) * 100) + '% 命中');
  console.log('  轮次总数      ' + totalTurns);
  console.log('');
}

process.exit(summary.ok ? 0 : 1);
