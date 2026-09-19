/**
 * End-to-end agent evaluation.
 *
 *   node evals/agent/run.mjs                 # 全部任务
 *   node evals/agent/run.mjs --only fix-bug  # 只跑一个
 *   node evals/agent/run.mjs --json
 *
 * Cost control (the whole point of this harness's shape):
 *   1. ONE script runs every task — no per-task process or discovery overhead.
 *   2. Grading is deterministic (filesystem / string assertions), so scoring
 *      costs ZERO extra API calls. An LLM judge would double the spend.
 *   3. Each task has a wall-clock timeout AND a low tool-round cap, so a
 *      misbehaving run cannot burn the budget.
 *   4. Token usage per task is printed, so the cost of an eval run is visible.
 *
 * Offline parts (fixtures, grading) never touch the network.
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

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

// Bound a single task so a runaway loop cannot spend without limit.
const TASK_TIMEOUT_MS = Number(process.env.SHE_EVAL_TIMEOUT_MS) || 150_000;
process.env.SHE_MAX_TOOL_ROUNDS = process.env.SHE_MAX_TOOL_ROUNDS || '10';

const { tasks } = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const selected = only ? tasks.filter((t) => t.id === only) : tasks;
if (selected.length === 0) {
  console.error(`没有匹配的任务: ${only}`);
  process.exit(1);
}

// ── grading ─────────────────────────────────────────────────────────────────
/**
 * Grade with deterministic assertions only.
 *
 * `usage` is passed in so cost-shaped regressions can be graded too. A greeting
 * once cost 66k prompt tokens because a stale plan was resumed and 31 shell
 * commands ran; "the answer was fine but it cost 20x too much" is exactly the
 * kind of failure that an outcome-only check cannot see.
 */
function gradeOne(check, ctx) {
  const { workspaceRoot, reply, usage } = ctx;
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
    return { pass: false, detail: `未知判据类型: ${check.type}` };
  } catch (err) {
    return { pass: false, detail: `判分异常: ${err.message.slice(0, 100)}` };
  }
}

/** A check is either one assertion or an `all` list of them. */
function grade(check, ctx) {
  if (Array.isArray(check.all)) {
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
  const shell = new SandboxShell(dir, cfg.sandbox);
  const tools = createTools(shell, dir, { allowAllCommands: true });
  const agent = new Agent(cfg, engine, tools, null);

  const t0 = Date.now();
  let reply = '';
  let timedOut = false;
  // A task is either one prompt or a sequence of turns against the SAME agent.
  // Multi-turn is what exercises context retention: turn 2 has to know what turn 1
  // did, which is exactly the behaviour that was reported broken.
  const turns = Array.isArray(task.turns) ? task.turns : [task.prompt];
  let turnsDone = 0;
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
    : grade(task.check, { workspaceRoot: dir, reply, usage });

  const filesLeft = existsSync(dir) ? readdirSync(dir).length : 0;
  store.close();
  rmSync(dir, { recursive: true, force: true });

  return {
    id: task.id,
    pass: g.pass,
    detail: g.detail,
    ms,
    turns: turns.length,
    tokens: usage.total_tokens ?? 0,
    promptTokens: usage.prompt_tokens ?? 0,
    cacheHitTokens: usage.cache_hit_tokens ?? 0,
    cacheMissTokens: usage.cache_miss_tokens ?? 0,
    prompt: turns[0],
    reply: reply.slice(0, 200),
    filesLeft,
    note: task.note,
  };
}

// ── driver ──────────────────────────────────────────────────────────────────
console.log(`\nAgent 评测：${selected.length} 个任务`);
console.log(`模型: ${loadConfig(ROOT).llm.model}   单任务超时: ${TASK_TIMEOUT_MS / 1000}s   工具轮次上限: ${process.env.SHE_MAX_TOOL_ROUNDS}`);
console.log('判分方式：文件系统 / 字符串断言（不调用 LLM 判分）\n');

const results = [];
for (const task of selected) {
  process.stdout.write(`  跑 ${task.id} ... `);
  const r = await runTask(task);
  results.push(r);
  console.log(`${r.pass ? '✓ 通过' : '✗ 失败'}  ${(r.ms / 1000).toFixed(1)}s  ${r.tokens} tokens${r.pass ? '' : '  — ' + r.detail}`);
}

const passed = results.filter((r) => r.pass).length;
const totalTokens = results.reduce((a, r) => a + r.tokens, 0);
const totalPrompt = results.reduce((a, r) => a + r.promptTokens, 0);
const totalCacheHit = results.reduce((a, r) => a + (r.cacheHitTokens ?? 0), 0);
const totalCacheMiss = results.reduce((a, r) => a + (r.cacheMissTokens ?? 0), 0);
const totalMs = results.reduce((a, r) => a + r.ms, 0);
const totalTurns = results.reduce((a, r) => a + (r.turns ?? 1), 0);

if (asJson) {
  console.log(JSON.stringify({
    model: loadConfig(ROOT).llm.model,
    passed,
    total: results.length,
    totalTokens,
    totalPromptTokens: totalPrompt,
    totalCacheHitTokens: totalCacheHit,
    totalCacheMissTokens: totalCacheMiss,
    totalTurns,
    totalMs,
    results,
  }, null, 2));
} else {
  console.log('\n' + '─'.repeat(84));
  for (const r of results) {
    const cache = r.cacheHitTokens != null && r.promptTokens
      ? `  缓存命中 ${Math.round((r.cacheHitTokens / r.promptTokens) * 100)}%`
      : '';
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.id.padEnd(24)} ${String(r.tokens).padStart(7)} tokens   ${(r.ms / 1000).toFixed(1)}s${cache}`);
    if (!r.pass) console.log(`      ${r.detail}`);
    if (!r.pass && r.reply) console.log(`      回复: ${r.reply.replace(/\n/g, ' ').slice(0, 120)}`);
  }
  console.log('─'.repeat(84));
  console.log(`  通过率        ${passed}/${results.length} (${Math.round((passed / results.length) * 100)}%)`);
  console.log(`  轮次总数      ${totalTurns}`);
  console.log(`  本轮 API 用量  ${totalTokens} tokens (prompt ${totalPrompt})`);
  if (totalCacheHit > 0 || totalCacheMiss > 0) {
    const cacheRate = Math.round((totalCacheHit / Math.max(1, totalCacheHit + totalCacheMiss)) * 100);
    // The prompt figure above is what is BILLED at full rate only for the miss
    // portion, so reporting both keeps the cost number honest.
    console.log(`  提示缓存      ${totalCacheHit} 命中 / ${totalCacheMiss} 未命中  → ${cacheRate}% 命中`);
  }
  console.log(`  总耗时        ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  平均每任务     ${Math.round(totalTokens / results.length)} tokens，每轮 ${Math.round(totalPrompt / Math.max(1, totalTurns))} prompt tokens\n`);
}

/*
 * Grade on the RATE, not on "all of them".
 *
 * These tasks measure agent behaviour, which varies between runs. Demanding 10/10
 * makes the gate flaky, and a gate that goes red at random is one people learn to
 * ignore. A floor still catches a real regression — a broken tool loses its task every
 * time — while one unlucky sample does not.
 */
const THRESHOLD = Number(process.env.SHE_AGENT_THRESHOLD ?? 0.8);
const rate = results.length ? passed / results.length : 0;
if (rate < THRESHOLD) {
  console.log(`  低于门槛 ${Math.round(THRESHOLD * 100)}% —— 有行为回归。先重跑确认是不是波动。\n`);
}

process.exit(rate >= THRESHOLD ? 0 : 1);
