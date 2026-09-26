/**
 * Tool-result classification — offline, no API calls, no ports.
 *
 * The classifier is a set of patterns over OTHER people's messages, which makes it the
 * easiest thing in the tree to break silently: change an error string in a tool and the
 * classification quietly becomes `unknown`, which reads as "a failure happened" and is
 * therefore never noticed. So this check does not restate the patterns. It drives the
 * REAL producers and reads what they actually return:
 *
 *   1. Real sandbox / KB / plan tools, executed against a temp workspace.
 *   2. Every `Error: ...` message literal in the source tree, extracted from the code.
 *   3. A real Agent turn, to prove the annotation reaches the model and the failure counter.
 *
 * Section 2 is the ratchet. Section 1 alone would pass forever while a message drifted;
 * section 2 fails the moment a new error message appears that no rule recognises.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../packages/shared/dist/index.js';
import { KBStore, GroupKBEngine } from '../packages/kb/dist/index.js';
import { SandboxShell, createTools } from '../packages/sandbox/dist/index.js';
import {
  Agent,
  createKBTools,
  createPlanTools,
  createPreflightTools,
  classifyToolResult,
  annotateToolResult,
  isToolFailure,
} from '../packages/agent-runtime/dist/index.js';
import { removeTempDir } from './lib/temp.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';
const dir = mkdtempSync(join(tmpdir(), 'she-toolresult-'));
mkdirSync(join(dir, '.she'), { recursive: true });
writeFileSync(join(dir, 'present.ts'), 'export const a = 1;\n', 'utf8');

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
  }
};

const cfg = loadConfig(PROJECT_ROOT);
cfg.workspace.root = dir;

const store = new KBStore(join(dir, 'kb.sqlite'));
const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(dir, 'kb.sqlite') });
const shell = new SandboxShell(dir, cfg.sandbox);
const sandboxTools = createTools(shell, dir, { allowAllCommands: true });
const planTools = createPlanTools(dir, null);
const kbTools = createKBTools(engine);
/*
 * A sandbox that still refuses things. `loadConfig` relaxes the destructive default when the
 * workspace allows everything, which is right for the product and useless for testing the
 * refusal path — the first version of this check "tested" a denial with `rm -rf /` under a
 * permissive config, and cmd.exe answered `'rm' is not recognized`, so nothing was refused
 * and the assertion silently measured the wrong thing.
 */
const strictShell = new SandboxShell(dir, { ...cfg.sandbox, denyDestructiveByDefault: true, allowAllCommands: false });
const strictTools = createTools(strictShell, dir, { allowAllCommands: false });

/** Run one real tool and return the string the agent would classify. */
async function run(toolset, name, args) {
  try {
    return await toolset.execute(name, args);
  } catch (err) {
    // The agent wraps a thrown error exactly like this before classifying it.
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─── 1. 真实生产者 ──────────────────────────────────────────────────────────
console.log('\n=== 真实工具产出的结果 ===');
{
  /*
   * The shell commands are spelled for the platform actually running this check.
   *
   * `cmd /c …` is a Windows built-in, so on POSIX it is not a command at all: `/bin/sh` answers
   * `cmd: not found` and exits 127. That made 「shell 成功」 FAIL on CI while passing on Windows,
   * and made 「shell 非零退出码」 pass for the wrong reason (127 is non-zero, but not because of
   * `exit 3` — the check was asserting a number, not the behaviour it named). This is the same
   * defect the timeout case below already split on platform for.
   */
  const shellOk = IS_WINDOWS ? 'cmd /c echo hi' : 'echo hi';
  const shellExit3 = IS_WINDOWS ? 'cmd /c exit 3' : 'exit 3';
  /*
   * The destructive command, aimed at something inside the throwaway workspace.
   *
   * `isDestructive` is a plain regex over the command text (`/rm\s+-rf/i`), so a path that is
   * local trips it exactly like `/` does — but if the denial ever regresses, this deletes a
   * directory that does not exist in a temp folder instead of the CI runner's filesystem.
   * A check may only be this dangerous by accident, never on purpose.
   */
  const destructiveProbe = 'rm -rf ./.she-check-destructive-probe';
  const cases = [
    // [label, toolset, name, args, expected kind]
    ['grep 无匹配', sandboxTools, 'grep', { pattern: 'zzz_no_such_symbol_zzz' }, 'empty'],
    ['shell 非零退出码', sandboxTools, 'shell', { command: shellExit3 }, 'nonzero_exit'],
    ['shell 成功', sandboxTools, 'shell', { command: shellOk }, 'none'],
    /*
     * A destructive command does NOT fail here — the sandbox asks the user first, and
     * "waiting for a human" is a state rather than a failure. Asserting `permission` for this
     * was wrong, and the check said so by returning the confirm payload. The refusal path is
     * exercised separately, below, against the raw shell result.
     */
    ['破坏性命令先要确认（不是失败）', strictTools, 'shell', { command: destructiveProbe }, 'none'],
    ['fs_read 文件不存在', sandboxTools, 'fs_read', { path: 'nope/missing.ts' }, 'not_found'],
    ['fs_read 工作区外（越权）', sandboxTools, 'fs_read', { path: '../../../etc/passwd' }, 'permission'],
    ['未知工具', sandboxTools, 'definitely_not_a_tool', {}, 'unavailable'],
    ['plan_update 状态词写错', planTools, 'plan_update', { plan_id: 'p', step_id: 's', status: '乱七八糟' }, 'invalid_args'],
    ['kb_query 无结果', kbTools, 'kb_query', { query: 'zzz_nothing_matches_zzz' }, 'empty'],
    ['成功读取', sandboxTools, 'fs_read', { path: 'present.ts' }, 'none'],
  ];

  for (const [label, toolset, name, args, expected] of cases) {
    const raw = await run(toolset, name, args);
    const v = classifyToolResult(name, raw);
    check(`${label} → ${expected}`, v.kind === expected,
      `实际 ${v.kind}\n原始返回: ${String(raw).slice(0, 200)}`);
  }

  /*
   * The timeout case is built with a deliberately short budget rather than the workspace
   * default, and the command is one that cannot finish inside it. On Windows `ping` is the
   * portable sleep; on POSIX it is `sleep`.
   */
  const impatient = new SandboxShell(dir, { ...cfg.sandbox, timeout: 600, allowAllCommands: true });
  const slow = createTools(impatient, dir, { allowAllCommands: true });
  const slowCommand = IS_WINDOWS ? 'ping -n 6 127.0.0.1' : 'sleep 5';
  const timedOut = await run(slow, 'shell', { command: slowCommand });
  check('shell 超时 → timeout', classifyToolResult('shell', timedOut).kind === 'timeout',
    `实际 ${classifyToolResult('shell', timedOut).kind}\n原始返回: ${String(timedOut).slice(0, 200)}`);

  /*
   * The refusal path, taken from the shell itself rather than through the tool wrapper.
   *
   * The wrapper turns a dangerous call into a confirm request before the sandbox ever sees
   * it, so the `denied` result is only reachable one level down. Reading `exec` directly is
   * how the `DENIED:` producer — the one message the classifier reads as a prefix — is
   * exercised at all.
   */
  const refused = await strictShell.exec(destructiveProbe);
  check('沙箱确实拒绝破坏性命令', refused.denied === true && /^DENIED:/.test(refused.stderr),
    JSON.stringify(refused).slice(0, 200));
  check('DENIED 结果 → permission',
    classifyToolResult('shell', `DENIED: ${refused.stderr}`).kind === 'permission');

  /*
   * A deny-list refusal that is NOT a destructive command, which is the other way a `DENIED`
   * reaches the model: an unlisted command under an allow-list sandbox.
   */
  const allowListed = new SandboxShell(dir, { ...cfg.sandbox, allowAllCommands: true, allowedCommands: ['echo'] });
  // Any command the allow-list does not name; spelled per platform for the same reason as above.
  const notListed = await allowListed.exec(IS_WINDOWS ? 'cmd /c dir' : 'ls');
  check('白名单外的命令被拒绝', notListed.denied === true, JSON.stringify(notListed).slice(0, 200));
  check('白名单拒绝 → permission',
    classifyToolResult('shell', `DENIED: ${notListed.stderr}`).kind === 'permission',
    notListed.stderr);

  /*
   * A timeout must NOT be reported as an ordinary failed command: only one of the two is
   * worth retrying with a smaller request, and the exit-code check used to shadow this
   * because a timed-out command also carries `exit code: -1`.
   */
  check('超时是可重试的，失败的命令不是',
    classifyToolResult('shell', timedOut).retryable === true
    && classifyToolResult('shell', 'exit code: 1').retryable === false);

  /*
   * Output that merely mentions the markers must not be misread. These are the false
   * positives that make a classifier worse than none: once a legitimate result is called a
   * failure, the model learns to ignore the label.
   */
  const falsePositives = [
    ['grep 命中里含 DENIED', 'src/shell.ts:1: throw "DENIED: destructive command blocked"', 'none'],
    ['grep 命中里含 timeout 字样', 'src/a.ts:9: const timeout = 5000;', 'none'],
    ['shell 打印 (timed out) 但退出码为 0', 'stdout:\n(timed out)\nexit code: 0', 'none'],
    ['shell 输出里含假 exit code: 1，真退出码为 0', 'stdout:\nexit code: 1\nexit code: 0', 'none'],
  ];
  for (const [label, text, expected] of falsePositives) {
    const kind = classifyToolResult('t', text).kind;
    check(`${label} → ${expected}`, kind === expected, `实际 ${kind}`);
  }

  /*
   * A well-formed call that the current STATE does not allow, driven through the real
   * preflight tool: it refuses to analyse before any user turn has been recorded.
   */
  const preflightTools = createPreflightTools(dir, {
    getRequest: () => '',
    listTools: () => ['fs_read'],
  });
  const noRequest = await run(preflightTools, 'preflight_record', { stated_intent: 's', actual_goal: 'g' });
  check('无用户请求时调用 preflight → precondition',
    classifyToolResult('preflight_record', noRequest).kind === 'precondition',
    `${classifyToolResult('preflight_record', noRequest).kind}\n${noRequest}`);
}

// ─── 2. 源码里每一句 Error: 都要能分类 ─────────────────────────────────────
console.log('\n=== 源码里的 Error: 文案全部可分类 ===');
{
  const PKG = join(PROJECT_ROOT, 'packages');
  const files = [];
  /*
   * `she-cli` is skipped: it is the terminal client, so its `Error:` strings are printed to a
   * person, never returned as a tool result. Including it made the ratchet demand a
   * classification for `${chunk.error ?? ...}` — a fragment of a frame the CLI was relaying,
   * not a message any tool can produce. Excluded by name rather than by a heuristic, so the
   * scope of the ratchet is explicit.
   */
  const NOT_TOOL_RESULTS = new Set(['she-cli']);
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (e === 'node_modules' || e === 'dist' || e === '__tests__' || e.startsWith('.')) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') || p.endsWith('.tsx')) files.push(p);
    }
  };
  for (const e of readdirSync(PKG)) {
    if (NOT_TOOL_RESULTS.has(e)) continue;
    const p = join(PKG, e, 'src');
    try { if (statSync(p).isDirectory()) walk(p); } catch { /* package without src */ }
  }

  /** Strip comments so a commented-out example is not treated as a producer. */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  /*
   * ── What this scan covers, and what it deliberately does not ──
   *
   * Scope: string literals that BEGIN with `Error: `, extracted from every package except
   * the terminal client. That is the return convention every tool executor in this repo
   * uses for a failure the model will read, so it selects the tool-result text precisely.
   *
   * Out of scope, on purpose: `new Error(...)` throw sites. Including them pulled in 61
   * messages that never reach the model — provider transport errors, KB engine invariant
   * violations, HTTP-handler conditions in `agent.ts` (`no pending patches`), plugin-manager
   * and session-store internals. Inventing a "remedy" for a message the model never sees
   * would be padding the table, and it would make this check fail every time unrelated
   * internal machinery added a guard.
   *
   * The thrown-from-a-tool-body shape — `new Error('Path escapes workspace: ...')`, which
   * the agent wraps as `Error: ...` before classifying — is therefore NOT covered statically.
   * It is covered by driving the real tools above, which is how that case was found at all:
   * the check reported `unknown` for `fs_read ../../../etc/passwd` and the escape rule exists
   * because of it. Run-driven, not string-scanned.
   *
   * Two shapes the extraction has to get right, both of which broke an earlier attempt:
   *   - messages containing a quote of their own: `Error: plugin tool "${name}" is not
   *     available` was truncated at the inner `"`, losing the words that identify it.
   *   - TypeScript ANNOTATIONS (`Error: Error | null = null;`) which are not messages; they
   *     are not inside string literals, so anchoring on literals excludes them without a
   *     filter that would be guesswork.
   */
  const seen = new Map(); // message → file
  for (const f of files) {
    const text = stripComments(readFileSync(f, 'utf8'));
    const literal = /(`[^`]*`|'[^'\n]*'|"[^"\n]*")/g;
    let m;
    while ((m = literal.exec(text)) !== null) {
      // `${...}` stands for a value computed at runtime; the shape is what gets classified.
      const body = m[1].slice(1, -1).replace(/\$\{[^{}]*\}/g, 'X');
      if (!body.startsWith('Error: ')) continue;
      const msg = body.trim();
      if (msg.length < 10) continue;
      if (!seen.has(msg)) seen.set(msg, relative(PROJECT_ROOT, f));
    }
  }

  check(`源码里找到 ${seen.size} 条 Error: 文案`, seen.size > 15, `只找到 ${seen.size} 条，提取规则可能失效了`);

  const unclassified = [];
  for (const [msg, file] of seen) {
    if (classifyToolResult('t', msg).kind === 'unknown') unclassified.push(`${msg}   (${file})`);
  }
  check('没有无法分类的 Error: 文案', unclassified.length === 0,
    `${unclassified.length} 条未分类:\n` + unclassified.join('\n'));

  /*
   * And the messages that ARE classified must not all land in the same bucket: a rule that
   * swallows everything (`/./`) would pass the assertion above while telling the model
   * nothing. This is what makes the ratchet meaningful rather than merely satisfied.
   */
  const kinds = new Set([...seen.keys()].map((m) => classifyToolResult('t', m).kind));
  check(`${kinds.size} 种失败原因被真实文案命中（不是全落进一类）`, kinds.size >= 3,
    [...kinds].join(', '));
  console.log(`        命中: ${[...kinds].sort().join(', ')}`);
}

// ─── 3. 接进真实 Agent ──────────────────────────────────────────────────────
console.log('\n=== 接入真实 Agent ===');
{
  /** A tool that fails the way a failed command does. */
  const defs = [{
    name: 'bad_command',
    description: 'Returns a failed shell result.',
    parameters: { type: 'object', properties: {}, required: [] },
  }, {
    name: 'quiet_lookup',
    description: 'Returns the empty-result sentinel.',
    parameters: { type: 'object', properties: {}, required: [] },
  }, {
    name: 'needs_ok',
    description: 'Asks for confirmation.',
    parameters: { type: 'object', properties: {}, required: [] },
    isDangerous: true,
  }];

  const execute = async (name) => {
    if (name === 'bad_command') return 'stdout:\nboom\nexit code: 3';
    if (name === 'quiet_lookup') return 'No matches found';
    return JSON.stringify({ needs_confirm: true, awaiting: 'user_approval', tool: 'needs_ok' });
  };

  /** Plays one round of tool calls, then stops — the same shape the unit tests use. */
  let step = 0;
  const seen = [];
  const scripts = [
    [{ name: 'bad_command', args: {} }, { name: 'quiet_lookup', args: {} }, { name: 'needs_ok', args: {} }],
  ];
  const provider = {
    name: 'stub',
    async chat(messages) {
      for (const m of messages) seen.push(`${m.role}:${String(m.content ?? '')}`);
      const calls = scripts[step];
      if (!calls) return { role: 'assistant', content: 'done' };
      step++;
      return {
        role: 'assistant',
        content: '',
        tool_calls: calls.map((c, i) => ({
          id: `call_${step}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      };
    },
  };

  const observed = [];
  const agent = new Agent(
    { ...cfg, llm: { ...cfg.llm, model: 'stub' }, sandbox: { ...cfg.sandbox, allowAllCommands: true } },
    engine,
    { definitions: defs, execute },
    null,
    // Same injection the other agent checks use: the constructor builds a real provider.
    {},
  );
  agent.provider = provider;
  agent.toolObserver = (name, _ms, failed) => observed.push({ name, failed });

  await agent.chat('跑几个会失败的工具', () => {});

  const modelSaw = seen.join('\n---\n');
  check('失败的命令被算作失败', observed.some((o) => o.name === 'bad_command' && o.failed === true),
    JSON.stringify(observed));
  check('空结果被算作失败（没拿到数据）', observed.some((o) => o.name === 'quiet_lookup' && o.failed === true),
    JSON.stringify(observed));
  check('确认门不算失败', observed.some((o) => o.name === 'needs_ok' && o.failed === false),
    JSON.stringify(observed));

  check('模型看到了失败命令的退出码', /exit code: 3/.test(modelSaw));
  check('模型看到了失败命令的去路', /\[tool-result\].*退出码不是 0/s.test(modelSaw),
    modelSaw.slice(-500));
  check('模型看到了"没有匹配"的去路', /\[tool-result\].*没有任何匹配/s.test(modelSaw),
    modelSaw.slice(-500));
  check('确认门的结果没有被加注释', !/"awaiting":"user_approval"[^]*?\[tool-result\]/.test(modelSaw));
  check('注释带 [tool-result] 标记而不是 [系统提示]',
    modelSaw.includes('[tool-result]') && !modelSaw.includes('[系统提示]'));

  // The transcript is one document: a reload renders history, streaming renders the chunk.
  const historyText = agent.getHistory().map((m) => String(m.content ?? '')).join('\n');
  check('落盘的 history 与模型看到的一致（含注释）', historyText.includes('[tool-result]'));
}

store.close();
removeTempDir(dir);
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
