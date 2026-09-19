/**
 * Does the agent verify its own work?
 *
 * The prompt asks it to check edits rather than assume they are right, but a prompt
 * instruction that nothing measures is a wish. This grades behaviour instead:
 *
 *   - a task whose "obvious" answer is WRONG unless the agent actually runs something
 *   - a task where the first attempt will fail, testing whether the failure is
 *     reported honestly rather than papered over
 *
 * Deterministic grading, one API call per task.
 */
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { loadConfig } from '../../packages/shared/dist/index.js';
import { KBStore, GroupKBEngine } from '../../packages/kb/dist/index.js';
import { SandboxShell, createTools } from '../../packages/sandbox/dist/index.js';
import { Agent } from '../../packages/agent-runtime/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const { tasks } = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
const args = process.argv.slice(2);
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const selected = only ? tasks.filter((t) => t.id === only) : tasks;

const TIMEOUT = Number(process.env.SHE_EVAL_TIMEOUT_MS) || 180_000;
process.env.SHE_MAX_TOOL_ROUNDS = process.env.SHE_MAX_TOOL_ROUNDS || '12';

console.log(`\n自我验证评测：${selected.length} 个任务\n`);

const results = [];

for (const task of selected) {
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

  process.stdout.write(`  跑 ${task.id} ... `);
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
  results.push({ id: task.id, pass, detail, ms, tokens: usage.total_tokens ?? 0, reply: reply.slice(0, 260) });
  console.log(`${pass ? '✓ 通过' : '✗ 失败'}  ${(ms / 1000).toFixed(1)}s  ${usage.total_tokens ?? 0} tokens${pass ? '' : '  — ' + detail}`);
}

const passed = results.filter((r) => r.pass).length;
const tokens = results.reduce((a, r) => a + r.tokens, 0);

console.log('\n' + '─'.repeat(80));
for (const r of results) {
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.id.padEnd(26)} ${String(r.tokens).padStart(7)} tokens   ${(r.ms / 1000).toFixed(1)}s`);
  if (!r.pass) {
    console.log(`      ${r.detail}`);
    if (r.reply) console.log(`      回复: ${r.reply.replace(/\n/g, ' ').slice(0, 200)}`);
  }
}
console.log('─'.repeat(80));

/*
 * Grade on the RATE, not on "all of them".
 *
 * These tasks measure agent behaviour, which varies between runs: the same prompt
 * occasionally takes a different path and lands somewhere slightly different. Demanding
 * 5/5 makes the gate flaky, and a gate that goes red at random is a gate people learn
 * to ignore — which defeats the purpose.
 *
 * A floor still catches what matters: a real regression drops the rate (a broken tool
 * loses its task every time), while one unlucky sample does not. The threshold is a
 * fraction rather than an absolute so it keeps working as tasks are added.
 */
const THRESHOLD = Number(process.env.SHE_VERIFY_THRESHOLD ?? 0.8);
const rate = results.length ? passed / results.length : 0;

console.log(`  通过率  ${passed}/${results.length}  (${Math.round(rate * 100)}%)   门槛 ${Math.round(THRESHOLD * 100)}%`);
console.log(`  用量    ${tokens} tokens`);
if (rate < THRESHOLD) {
  console.log(`\n  低于门槛 —— 至少一项行为回归了。单次波动很常见，先重跑一次确认。`);
} else if (passed < results.length) {
  console.log(`\n  有个别失败但达到门槛。它们可能是波动，也可能是刚出现的不稳定，值得看一眼。`);
}
console.log('');

process.exit(rate >= THRESHOLD ? 0 : 1);
