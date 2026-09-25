/**
 * Does the agent verify its own work?
 *
 *   node evals/verification/run.mjs                # 全部任务
 *   node evals/verification/run.mjs --only <id>    # 只跑一个
 *   node evals/verification/run.mjs --repeat 3     # 每个任务跑 3 遍，报告方差
 *   node evals/verification/run.mjs --dry-run      # 只检查任务定义，不调用 API
 *
 * The prompt asks it to check edits rather than assume they are right, but a prompt
 * instruction that nothing measures is a wish. This grades behaviour instead:
 *
 *   - a task whose "obvious" answer is WRONG unless the agent actually runs something
 *   - a task where the first attempt will fail, testing whether the failure is
 *     reported honestly rather than papered over
 *
 * Deterministic grading, one API call per task. `--repeat` multiplies that, which is why
 * it is opt-in: a single sample cannot tell a regression from a flaky task, and
 * evals/lib/variance.mjs is what does once there is more than one.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { loadConfig } from '../../packages/shared/dist/index.js';
import { KBStore, GroupKBEngine } from '../../packages/kb/dist/index.js';
import { SandboxShell, createTools } from '../../packages/sandbox/dist/index.js';
import { Agent } from '../../packages/agent-runtime/dist/index.js';
import { summarize, formatReport } from '../lib/variance.mjs';
import { loadTasks, validateTasks, VERIFY_CHECKS } from '../lib/tasks.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const tasks = loadTasks(join(HERE, 'tasks.json'));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const selected = only ? tasks.filter((t) => t.id === only) : tasks;

const TIMEOUT = Number(process.env.SHE_EVAL_TIMEOUT_MS) || 180_000;
process.env.SHE_MAX_TOOL_ROUNDS = process.env.SHE_MAX_TOOL_ROUNDS || '12';

const THRESHOLD = Number(process.env.SHE_VERIFY_THRESHOLD ?? 0.8);
const repeatIdx = args.indexOf('--repeat');
const repeatArg = repeatIdx >= 0 ? args[repeatIdx + 1] : process.env.SHE_VERIFY_REPEAT;
const REPEATS = Math.max(1, Math.min(20, Number(repeatArg) || 1));

/** Validate the task file offline: a malformed task otherwise costs an API call to discover. */
function validate(list) {
  return validateTasks(list, { knownChecks: VERIFY_CHECKS });
}

if (dryRun) {
  const problems = validate(selected);
  console.log(`\n自我验证评测任务检查：${selected.length} 个任务（dry run，不调用任何 API）\n`);
  for (const t of selected) console.log(`  ${t.id.padEnd(26)} ${t.check?.type}`);
  if (problems.length) {
    console.log(`\n✗ ${problems.length} 个问题：`);
    for (const p of problems) console.log(`    ${p}`);
    process.exit(1);
  }
  console.log(`\n✓ 任务定义自洽（重跑次数 ${REPEATS}）`);
  process.exit(0);
}

async function runTask(task) {
  const dir = mkdtempSync(join(tmpdir(), `she-verify-${task.id}-`));
  mkdirSync(join(dir, '.she'), { recursive: true });
  for (const [name, content] of Object.entries(task.fixtures ?? {})) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }

  const cfg = loadConfig(ROOT);
  cfg.workspace.root = dir;
  cfg.llm.maxTokens = Math.min(cfg.llm.maxTokens, 2048);
  cfg.llm.thinkingLevel = 'low';
  cfg.llm.fallback = undefined;
  cfg.automationMode = true;
  cfg.sandbox.allowAllCommands = true;
  cfg.sandbox.denyDestructiveByDefault = false;

  const store = new KBStore(join(dir, '.she', 'kb.sqlite'));
  const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(dir, '.she', 'kb.sqlite') });
  const shell = new SandboxShell(dir, cfg.sandbox);
  const tools = createTools(shell, dir, { allowAllCommands: true });
  const agent = new Agent(cfg, engine, tools, null);

  const t0 = Date.now();
  let reply = '';
  let timedOut = false;
  try {
    const out = await Promise.race([
      agent.chat(task.prompt),
      new Promise((r) => setTimeout(() => { timedOut = true; r(null); }, TIMEOUT)),
    ]);
    reply = out?.content ?? '';
    if (timedOut) { try { agent.stop(); } catch { /* ignore */ } }
  } catch (err) {
    reply = `[异常] ${err.message}`;
  }
  const ms = Date.now() - t0;
  const usage = agent.getTokenUsage();

  // Deterministic grading only.
  let pass = false;
  let detail = '';
  if (timedOut) {
    detail = `超时 ${TIMEOUT}ms`;
  } else if (task.check.type === 'replyContains') {
    pass = reply.includes(task.check.expect);
    if (!pass) detail = `回复不含 "${task.check.expect}"`;
  } else if (task.check.type === 'replyLacks') {
    pass = !reply.includes(task.check.unexpected);
    if (!pass) detail = `回复不该出现 "${task.check.unexpected}"，实际: ${reply.slice(0, 120)}`;
  } else if (task.check.type === 'fileContains') {
    const p = join(dir, task.check.path);
    if (!existsSync(p)) { detail = `文件不存在: ${task.check.path}`; }
    else {
      const text = readFileSync(p, 'utf8');
      const missing = task.check.expect.filter((e) => !text.includes(e));
      pass = missing.length === 0;
      if (!pass) detail = `缺少: ${missing.join(' / ')}`;
    }
  }

  store.close();
  rmSync(dir, { recursive: true, force: true });
  return { id: task.id, pass, detail, ms, tokens: usage.total_tokens ?? 0, reply: reply.slice(0, 260) };
}

console.log(`\n自我验证评测：${selected.length} 个任务 × ${REPEATS} 遍\n`);

/*
 * One pass over the whole set per repeat, not N passes over one task in a row: a run that is
 * interrupted or runs out of budget then has samples spread across tasks instead of covering a
 * few of them deeply.
 */
const samples = [];
for (let rep = 0; rep < REPEATS; rep++) {
  if (REPEATS > 1) console.log(`第 ${rep + 1}/${REPEATS} 遍`);
  for (const task of selected) {
    process.stdout.write(`  跑 ${task.id} ... `);
    const r = await runTask(task);
    samples.push(r);
    console.log(`${r.pass ? '✓ 通过' : '✗ 失败'}  ${(r.ms / 1000).toFixed(1)}s  ${r.tokens} tokens${r.pass ? '' : '  — ' + r.detail}`);
  }
}

const summary = summarize(samples, { threshold: THRESHOLD });

console.log('');
for (const line of formatReport(summary)) console.log(line);
if (!summary.ok && summary.dead.length === 0) {
  console.log('  低于门槛但没有「每次都挂」的任务 —— 先按 --repeat 3 重跑，再判断是不是回归。');
}
console.log('');

process.exit(summary.ok ? 0 : 1);
