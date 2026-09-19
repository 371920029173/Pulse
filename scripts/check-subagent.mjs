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
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'she-subagent-'));
// Derive the project root from this file's location — never a literal path, so
// the check runs from any clone on any platform.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(PROJECT_ROOT);
cfg.workspace.root = dir;

const store = new KBStore(join(dir, 'kb.sqlite'));
const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(dir, 'kb.sqlite') });
const shell = new SandboxShell(dir, cfg.sandbox);
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
const parentRunner = { run: async () => ({ description: 'x', ok: true, result: 'ok' }) };
const parent = new Agent(cfg, engine, tools, null, { subagentRunner: parentRunner });
const parentTools = toolNames(parent);

record('父智能体有 task_spawn', parentTools.includes('task_spawn'), `${parentTools.length} 个工具`);
record('父智能体有 ask_user', parentTools.includes('ask_user'), '');

// ── child ───────────────────────────────────────────────────────────────────
const child = new Agent(cfg, engine, tools, null, { isSubagent: true });
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

console.log('\n  父智能体工具:', parentTools.join(', '));
console.log('  子智能体工具:', childTools.join(', '));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length} 通过 / ${failed.length} 失败`);

store.close();
rmSync(dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
