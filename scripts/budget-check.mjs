/**
 * Turn budget, read-only concurrency, and same-turn reuse — offline, no API calls, no ports.
 *
 * Three claims, in order of how much damage a silent regression would do:
 *
 *   1. **Off means off.** The budget is a switch whose default must leave behaviour
 *      byte-identical; a ceiling that armed itself would cut long tasks short for people who
 *      never asked for one, and they would have no way to know why. Asserted by running a real
 *      turn with the defaults and checking that nothing stops and every call happens.
 *   2. **On means the numbers are real.** Each axis is driven end-to-end through a real Agent —
 *      including the awkward one, a mid-message call ceiling, which must leave a transcript the
 *      next turn can still be appended to. "The turn stopped" is not the interesting part;
 *      "the conversation still works afterwards" is.
 *   3. **Reuse never returns a stale read.** The dangerous shape is a read that follows a write
 *      in the SAME message: starting it early hands the model the pre-write contents with
 *      nothing to distinguish it from a correct answer. So the assertions are about ordering and
 *      counts, not about speed.
 *
 * The modules are also exercised directly (`readsToPrefetch`, `queryKey`, `budgetStop`) because
 * the prefix rule and the query identity are the two places a future change could quietly
 * widen what runs in parallel.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig, tryLoadYaml, unknownTopLevelKeys } from '../packages/shared/dist/index.js';
import { KBStore, GroupKBEngine } from '../packages/kb/dist/index.js';
import { SandboxShell, createTools } from '../packages/sandbox/dist/index.js';
import {
  Agent,
  DEFAULT_BUDGET,
  MAX_PARALLEL_READS,
  RunTraceStore,
  budgetStop,
  isReadOnlyTool,
  parseBudgetLimits,
  queryKey,
  readsToPrefetch,
  renderBudgetStop,
} from '../packages/agent-runtime/dist/index.js';
import { removeTempDir } from './lib/temp.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 500)}`);
  }
};

const dirs = [];
function freshDir(tag) {
  const d = mkdtempSync(join(tmpdir(), `she-budget-${tag}-`));
  mkdirSync(join(d, '.she'), { recursive: true });
  dirs.push(d);
  return d;
}
function cleanup() {
  for (const d of dirs) removeTempDir(d);
}
process.on('exit', cleanup);

const cfg = loadConfig(PROJECT_ROOT);

/** One engine per workspace, closed by the caller. */
function makeEngine(ws) {
  const store = new KBStore(join(ws, 'kb.sqlite'));
  const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(ws, 'kb.sqlite') });
  return { store, engine };
}

/**
 * A toolset: the real sandbox tools plus whatever this section needs.
 *
 * Real `fs_read`/`fs_write` are used wherever the point is a genuine file, because a stub would
 * be asserting the stub. The synthetic tools are only for the properties a real file cannot
 * show: overlapping in time, and returning a specific failure string.
 */
function makeTools(ws, defs, impl, sandbox = {}) {
  const shell = new SandboxShell(ws, { ...cfg.sandbox, allowAllCommands: true, ...sandbox });
  const base = createTools(shell, ws, { allowAllCommands: true });
  const calls = [];
  return {
    calls,
    tools: {
      definitions: [...base.definitions, ...defs],
      execute: async (name, args) => {
        calls.push(name);
        if (impl[name]) return impl[name](args);
        return base.execute(name, args);
      },
    },
  };
}

const tool = (name, description = name) => ({
  name,
  description,
  parameters: { type: 'object', properties: {}, required: [] },
});

function makeAgent(ws, tools, provider, budget, opts = {}) {
  const { store, engine } = makeEngine(ws);
  const config = loadConfig(PROJECT_ROOT);
  config.workspace.root = ws;
  config.llm = { ...config.llm, model: 'stub', baseUrl: 'http://stub.invalid' };
  config.sandbox = { ...config.sandbox, allowAllCommands: true, denyDestructiveByDefault: false };
  config.budget = { ...DEFAULT_BUDGET, ...budget };
  // An explicit store so the assertions can read this turn's trace back.
  const runs = new RunTraceStore(ws);
  const agent = new Agent(config, engine, tools, opts.sessionId ?? null, { runTrace: runs });
  agent.provider = provider;
  return { agent, store, runs };
}

/** A provider that plays one round of tool calls per entry, then answers and stops. */
function scriptProvider(script) {
  let step = 0;
  const seen = [];
  return {
    name: 'stub',
    seen,
    rounds: () => step,
    async chat(messages) {
      seen.push(messages.map((m) => ({ role: m.role, content: String(m.content ?? ''), tool_calls: m.tool_calls })));
      const round = script[step];
      if (!round) return { role: 'assistant', content: 'done' };
      const index = step++;
      return {
        role: 'assistant',
        content: '',
        tool_calls: round.map((c, i) => ({
          id: `r${index}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        })),
      };
    },
  };
}

/** A provider that asks for the same call forever — for the round ceiling and the stuck detector. */
function repeatProvider(name) {
  let round = 0;
  const seen = [];
  return {
    name: 'stub',
    seen,
    rounds: () => round,
    async chat(messages) {
      seen.push(messages.map((m) => ({ role: m.role, content: String(m.content ?? ''), tool_calls: m.tool_calls })));
      round++;
      return {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: `rep_${round}`,
          type: 'function',
          function: { name, arguments: '{}' },
        }],
      };
    },
  };
}

/** Every tool call in the transcript has a result — the transcript is a legal request. */
function toolGroupIsClosed(history) {
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue;
    const need = new Set(m.tool_calls.map((c) => c.id));
    let j = i + 1;
    while (j < history.length && history[j].role === 'tool') {
      need.delete(history[j].tool_call_id);
      j++;
    }
    if (need.size) return [...need];
  }
  return null;
}

const budgetMessage = /已按预算停止/;

// ─── 1. 默认关闭：配置层 ──────────────────────────────────────────────────────
console.log('\n=== 默认关闭：开关本身 ===');
{
  const fromDefaults = loadConfig(PROJECT_ROOT).budget;
  check('默认配置里预算是关的，而且每一轴都是 0',
    fromDefaults.enabled === false
      && fromDefaults.maxToolRounds === 0 && fromDefaults.maxToolCalls === 0
      && fromDefaults.maxTokens === 0 && fromDefaults.maxSeconds === 0,
    JSON.stringify(fromDefaults));

  check('默认配置不认识「budget」以外的键会报警，但 budget 是被认识的',
    unknownTopLevelKeys({ budget: {}, server: {} }).length === 0,
    JSON.stringify(unknownTopLevelKeys({ budget: {}, server: {} })));

  const example = tryLoadYaml(join(PROJECT_ROOT, 'config.example.yaml'));
  check('config.example.yaml 里有 budget 段，且示例值就是关闭',
    example?.budget && example.budget.enabled === false,
    JSON.stringify(example?.budget));

  /*
   * Only the switch arms a limit. Somebody exporting `SHE_BUDGET_MAX_TOKENS` for their own shell
   * script must not start having their agent's turns cut short.
   */
  const saved = { ...process.env };
  try {
    process.env.SHE_BUDGET_MAX_TOKENS = '1234';
    delete process.env.SHE_BUDGET_ENABLED;
    const limitOnly = loadConfig(PROJECT_ROOT).budget;
    check('【关键】只设上限不设开关，仍然不生效（但上限读进来了）',
      limitOnly.enabled === false && limitOnly.maxTokens === 1234, JSON.stringify(limitOnly));

    process.env.SHE_BUDGET_ENABLED = '1';
    process.env.SHE_BUDGET_MAX_TOOL_CALLS = '7';
    process.env.SHE_BUDGET_MAX_SECONDS = '90';
    const armed = loadConfig(PROJECT_ROOT).budget;
    check('SHE_BUDGET_ENABLED=1 打开，并且各轴从环境变量读进来',
      armed.enabled === true && armed.maxToolCalls === 7 && armed.maxSeconds === 90, JSON.stringify(armed));

    process.env.SHE_BUDGET_ENABLED = '0';
    check('SHE_BUDGET_ENABLED=0 明确关闭', loadConfig(PROJECT_ROOT).budget.enabled === false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
  }

  // A YAML file, the other way in.
  const ws = freshDir('yaml');
  writeFileSync(join(ws, 'she.config.yaml'), [
    'budget:',
    '  enabled: true',
    '  maxToolRounds: 3',
    '  maxTokens: 20k',
    '',
  ].join('\n'), 'utf8');
  const fromYaml = loadConfig(ws).budget;
  check('YAML 里的 budget 生效（enabled / maxToolRounds）',
    fromYaml.enabled === true && fromYaml.maxToolRounds === 3, JSON.stringify(fromYaml));
  check('【关键】YAML 里写坏的数值被丢掉，而不是变成 NaN（NaN 会让这一轴永不触发）',
    fromYaml.maxTokens === 0 && Number.isFinite(fromYaml.maxTokens), JSON.stringify(fromYaml));

  const wsNull = freshDir('yaml-null');
  writeFileSync(join(wsNull, 'she.config.yaml'), 'budget:\n', 'utf8');
  let threw = null;
  try {
    const nullBudget = loadConfig(wsNull).budget;
    check('空的 budget 段不会让启动崩掉，且保持关闭',
      nullBudget?.enabled === false && nullBudget.maxTokens === 0, JSON.stringify(nullBudget));
  } catch (err) {
    threw = err;
    check('空的 budget 段不会让启动崩掉，且保持关闭', false, String(err));
  }
  if (threw) check('（上面那条的堆栈）', false, threw.stack);
}

// ─── 2. 默认关闭：跑起来也不拦 ───────────────────────────────────────────────
console.log('\n=== 默认关闭：真实一轮不受影响 ===');
{
  const ws = freshDir('off');
  let n = 0;
  const { tools, calls } = makeTools(ws, [tool('work')], {
    // A fresh result each round: identical results would trip the stuck-loop detector and the
    // turn would end for a reason that has nothing to do with the budget.
    work: async () => `did some work ${++n}`,
  });
  /*
   * Six rounds. With the switch off this must run to the end; the round ceiling only exists to
   * make the "on" case below assertable, so if it ever starts firing while disabled, this is the
   * line that says so.
   */
  const provider = scriptProvider(Array.from({ length: 6 }, () => [{ name: 'work', args: {} }]));
  const { agent, store, runs } = makeAgent(ws, tools, provider, {});
  try {
    const reply = await agent.chat('一直做下去', () => {});
    check('【关键】关闭时不会因为预算停下', !budgetMessage.test(String(reply.content)), String(reply.content).slice(0, 200));
    check('关闭时每一次调用都真的执行了', calls.filter((c) => c === 'work').length === 6, JSON.stringify(calls));
    const run = runs.list()[0] ? runs.read(runs.list()[0].id)?.run : null;
    check('关闭时轨迹的结束理由是「完成」，不是预算',
      run?.state === 'done' && run?.reason !== 'budget', JSON.stringify({ state: run?.state, reason: run?.reason }));
  } finally {
    store.close();
  }
}

// ─── 3. 打开：轮数上限 ───────────────────────────────────────────────────────
console.log('\n=== 打开：轮数上限 ===');
{
  const ws = freshDir('rounds');
  let n = 0;
  const { tools, calls } = makeTools(ws, [tool('work')], { work: async () => `ok ${++n}` });
  const provider = repeatProvider('work');
  const { agent, store, runs } = makeAgent(ws, tools, provider, { enabled: true, maxToolRounds: 2 });
  try {
    const reply = await agent.chat('一直做下去', () => {});
    const text = String(reply.content);
    check('【关键】到轮数上限就停，并说明是预算', budgetMessage.test(text), text.slice(0, 300));
    check('文案里有具体上限和已用量', /上限 2 轮模型调用/.test(text) && /已用到 2/.test(text), text.slice(0, 300));
    check('文案告诉用户能接着说「继续」', /说「继续」/.test(text), text.slice(0, 300));
    check('【关键】文案明确不是失败（否则会被当成崩溃）', /不是任务失败/.test(text), text.slice(0, 300));
    check('模型只被调用了上限那么多次（每次内部都发一次工具调用）',
      provider.rounds() === 2, String(provider.rounds()));
    check('工具也没有被多跑', calls.filter((c) => c === 'work').length === 2, JSON.stringify(calls));

    const run = runs.list()[0] ? runs.read(runs.list()[0].id)?.run : null;
    check('【关键】轨迹把这一轮记成「预算停止」，不是错误也不是完成',
      run?.state === 'failed' && run?.reason === 'budget', JSON.stringify({ state: run?.state, reason: run?.reason }));

    // And the conversation is still usable afterwards.
    const follow = scriptProvider([]);
    agent.provider = follow;
    const next = await agent.chat('继续', () => {});
    check('预算停止之后还能继续对话（不是把会话弄坏了）',
      /done/.test(String(next.content)), String(next.content).slice(0, 200));
  } finally {
    store.close();
  }
}

// ─── 4. 打开：调用次数上限（消息中途） ────────────────────────────────────────
console.log('\n=== 打开：调用次数上限（一条消息里就超） ===');
{
  const ws = freshDir('calls');
  const { tools, calls } = makeTools(ws, [tool('a'), tool('b'), tool('c')], {
    a: async () => 'A',
    b: async () => 'B',
    c: async () => 'C',
  });
  const provider = scriptProvider([[{ name: 'a' }, { name: 'b' }, { name: 'c' }]]);
  const { agent, store } = makeAgent(ws, tools, provider, { enabled: true, maxToolCalls: 2 });
  try {
    const reply = await agent.chat('跑三个', () => {});
    const text = String(reply.content);
    check('【关键】上限之内的调用跑了，超出的没跑',
      calls.filter((c) => ['a', 'b', 'c'].includes(c)).join(',') === 'a,b', JSON.stringify(calls));
    check('【关键】被拦下的调用有一个明确的「没执行」结果，而不是凭空消失',
      /budget_exceeded/.test(text) === false, '预算文案本身不含内部字段（下面查轨迹内容）');
    const history = agent.getHistory();
    const notRun = history.filter((m) => m.role === 'tool' && /"not_run":true/.test(String(m.content)));
    check('少跑的那个调用的结果是 not_run', notRun.length === 1, JSON.stringify(notRun.map((m) => m.content)));
    check('【关键】对话记录仍是合法请求：每个工具调用都有结果',
      toolGroupIsClosed(history) === null, JSON.stringify(toolGroupIsClosed(history)));
    check('停止理由写的是调用次数',
      /上限 2 次工具调用/.test(text), text.slice(0, 300));

    const follow = scriptProvider([]);
    agent.provider = follow;
    const next = await agent.chat('继续', () => {});
    check('中途拦截之后还能继续对话', /done/.test(String(next.content)), String(next.content).slice(0, 200));
  } finally {
    store.close();
  }
}

// ─── 5. 打开：token 上限与时间上限 ───────────────────────────────────────────
console.log('\n=== 打开：token 上限 / 时间上限 ===');
{
  const ws = freshDir('tokens');
  const { tools, calls } = makeTools(ws, [tool('work')], { work: async () => 'ok' });
  const provider = {
    name: 'stub',
    async chat(_messages, _tools, onChunk) {
      // Usage arrives as a stream chunk, which is the only path the loop reads it from. Reported
      // above the ceiling on the FIRST response, so the tools it asked for must not run: a
      // ceiling consulted after the work is not a ceiling.
      onChunk?.({ type: 'usage', usage: { prompt_tokens: 900, completion_tokens: 200, total_tokens: 1100 } });
      return {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'work', arguments: '{}' } }],
      };
    },
  };
  const { agent, store } = makeAgent(ws, tools, provider, { enabled: true, maxTokens: 500 });
  try {
    const reply = await agent.chat('花很多钱', () => {});
    check('【关键】token 超了就停，且在这一轮的工具还没跑之前就停',
      budgetMessage.test(String(reply.content)) && calls.filter((c) => c === 'work').length === 0,
      `reply=${String(reply.content).slice(0, 120)} calls=${JSON.stringify(calls)}`);
    check('文案里点名 token 轴', /上限 500 token/.test(String(reply.content)), String(reply.content).slice(0, 300));
    check('并且说的是 SHE_BUDGET_MAX_TOKENS', /SHE_BUDGET_MAX_TOKENS/.test(String(reply.content)));
  } finally {
    store.close();
  }

  /*
   * The clock axis needs a turn that is actually slow, so the first tool sleeps past the ceiling
   * and the SECOND call is the one that must be refused. Cheap, and it exercises the check point
   * between two calls in one message rather than between two rounds.
   */
  const wsSlow = freshDir('seconds');
  const { tools: slowTools, calls: slowCalls } = makeTools(wsSlow, [tool('nap'), tool('after')], {
    nap: async () => { await new Promise((r) => setTimeout(r, 1200)); return 'slept'; },
    after: async () => 'should not run',
  });
  const slowProvider = scriptProvider([[{ name: 'nap' }, { name: 'after' }]]);
  const { agent: slowAgent, store: slowStore } = makeAgent(wsSlow, slowTools, slowProvider, { enabled: true, maxSeconds: 1 });
  try {
    const reply = await slowAgent.chat('先睡一秒', () => {});
    check('【关键】时间上限在两次调用之间生效：超时之后的调用没跑',
      !slowCalls.includes('after') && slowCalls.includes('nap'), JSON.stringify(slowCalls));
    check('时间轴的停止文案点名秒数', /上限 1 秒/.test(String(reply.content)), String(reply.content).slice(0, 200));
    check('被拦下的调用仍有 not_run 结果（记录合法）',
      toolGroupIsClosed(slowAgent.getHistory()) === null);
  } finally {
    slowStore.close();
  }
}

// ─── 6. 只读并发 ─────────────────────────────────────────────────────────────
console.log('\n=== 只读并发 ===');
{
  const ws = freshDir('parallel');
  writeFileSync(join(ws, 'one.txt'), 'first\n', 'utf8');
  writeFileSync(join(ws, 'two.txt'), 'second\n', 'utf8');
  writeFileSync(join(ws, 'three.txt'), 'needle\n', 'utf8');

  let inFlight = 0;
  let peak = 0;
  const started = [];
  const finished = [];
  const { tools } = makeTools(ws, [], {});
  const base = tools.execute;
  /*
   * Real sandbox read tools, wrapped so they take long enough to overlap. `fs_read`, `fs_list`,
   * `grep` and `git_status` are all in the read-only allowlist, so this measures the real code
   * path — a synthetic name would have been serial by design and proved nothing.
   */
  const reads = [
    { name: 'fs_read', args: { path: 'one.txt' } },
    { name: 'fs_read', args: { path: 'two.txt' } },
    { name: 'grep', args: { pattern: 'needle' } },
    { name: 'fs_list', args: { path: '.' } },
  ];
  tools.execute = async (name, args) => {
    if (reads.some((r) => r.name === name)) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      started.push(`${name}:${JSON.stringify(args)}`);
      await new Promise((r) => setTimeout(r, 150));
      const result = await base(name, args);
      finished.push(`${name}:${JSON.stringify(args)}`);
      inFlight--;
      return result;
    }
    return base(name, args);
  };

  check('这些名字真的在白名单里（否则这一节测的是串行路径）',
    reads.every((r) => isReadOnlyTool(r.name)), reads.map((r) => r.name).join(','));

  const provider = scriptProvider([reads]);
  const { agent, store } = makeAgent(ws, tools, provider, {});
  try {
    const t0 = Date.now();
    await agent.chat('同时读四个东西', () => {});
    const elapsed = Date.now() - t0;
    check(`【关键】四个只读调用真的重叠了（峰值 ${peak} 个在飞）`, peak >= 2, `peak=${peak}`);
    check(`【关键】总耗时接近一次而不是四次（${elapsed}ms）`, elapsed < 450, `${elapsed}ms；串行会是 600ms`);
    check('每个只读调用都跑了恰好一次（并发不会重复执行）',
      started.length === reads.length, `${JSON.stringify(started.length)} / ${reads.length}`);

    const toolMsgs = agent.getHistory().filter((m) => m.role === 'tool').map((m) => String(m.content));
    check('结果按请求顺序进记录（并发不打乱顺序）',
      toolMsgs.length === reads.length && toolMsgs[0].includes('first') && toolMsgs[1].includes('second'),
      JSON.stringify(toolMsgs.map((t) => t.slice(0, 30))));

    /*
     * The cap is a cap: more reads than the limit run in waves, which is why `MAX_PARALLEL_READS`
     * exists at all — a large workspace must not be hit forty times in the same instant.
     */
    check(`并发上限是个小数（${MAX_PARALLEL_READS}），不是「全部一起上」`,
      MAX_PARALLEL_READS >= 2 && MAX_PARALLEL_READS <= 8 && peak <= MAX_PARALLEL_READS,
      `peak=${peak} cap=${MAX_PARALLEL_READS}`);
  } finally {
    store.close();
  }

  /*
   * A write first: nothing may be prefetched, because the read that follows is of what the write
   * produced. Asserted as ordering — the read must not start before the write ends.
   */
  const ws2 = freshDir('prefix');
  const events = [];
  const { tools: t2 } = makeTools(ws2, [tool('write_x')], {
    write_x: async () => {
      events.push('write:start');
      await new Promise((r) => setTimeout(r, 60));
      events.push('write:end');
      return 'written';
    },
  });
  writeFileSync(join(ws2, 'later.txt'), 'content\n', 'utf8');
  const base2 = t2.execute;
  t2.execute = async (name, args) => {
    if (name === 'fs_read') {
      events.push('read:start');
      const r = await base2(name, args);
      events.push('read:end');
      return r;
    }
    return base2(name, args);
  };
  const provider2 = scriptProvider([[{ name: 'write_x' }, { name: 'fs_read', args: { path: 'later.txt' } }]]);
  const { agent: agent2, store: store2 } = makeAgent(ws2, t2, provider2, {});
  try {
    await agent2.chat('先写再读', () => {});
    const writeEnd = events.indexOf('write:end');
    const readStart = events.indexOf('read:start');
    check('【关键】写之后的读不会被提前启动（那会读到写之前的内容）',
      writeEnd >= 0 && readStart > writeEnd, JSON.stringify(events));
  } finally {
    store2.close();
  }
}

// ─── 7. 同轮复用 ─────────────────────────────────────────────────────────────
console.log('\n=== 同轮只读复用 ===');
{
  /*
   * Real files, real tools: wrap `fs_read` to count how many times the filesystem was actually
   * touched. The assertion is the count, because that is what the feature claims.
   */
  const ws = freshDir('reuse');
  writeFileSync(join(ws, 'same.txt'), 'stable content\n', 'utf8');
  const { tools } = makeTools(ws, [], {});
  const counts = new Map();
  const base = tools.execute;
  tools.execute = async (name, args) => {
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return base(name, args);
  };

  const readSame = [{ name: 'fs_read', args: { path: 'same.txt' } }];
  const provider = scriptProvider([readSame, readSame, readSame]);
  const { agent, store } = makeAgent(ws, tools, provider, {});
  const statuses = [];
  try {
    await agent.chat('反复读同一个文件', (c) => { if (c.type === 'status') statuses.push(c.content); });
    check('【关键】同一轮里同样的只读查询只碰了一次文件系统',
      counts.get('fs_read') === 1, JSON.stringify([...counts]));
    check('复用时给用户一条状态（说清为了快省掉了什么）',
      statuses.some((s) => /复用/.test(s)), JSON.stringify(statuses));
    const toolMsgs = agent.getHistory().filter((m) => m.role === 'tool').map((m) => String(m.content));
    check('复用回来的内容与第一次逐字节相同（模型看到的没有差别）',
      toolMsgs.length === 3 && toolMsgs.every((t) => t === toolMsgs[0]), JSON.stringify(toolMsgs));
    check('缓存的查询身份用的是规范化后的参数',
      queryKey('fs_read', '{"path":"same.txt"}') === queryKey('fs_read', '{"path": "same.txt"}'), null);
  } finally {
    store.close();
  }

  /*
   * A write in between invalidates: the read after it must hit the disk again, because
   * "the same query" is only the same answer while nothing has changed.
   */
  const ws2 = freshDir('reuse-invalidate');
  writeFileSync(join(ws2, 'mutable.txt'), 'v1\n', 'utf8');
  const { tools: t2 } = makeTools(ws2, [], {});
  const counts2 = new Map();
  const base2 = t2.execute;
  t2.execute = async (name, args) => {
    counts2.set(name, (counts2.get(name) ?? 0) + 1);
    return base2(name, args);
  };
  const provider2 = scriptProvider([
    [{ name: 'fs_read', args: { path: 'mutable.txt' } }],
    [{ name: 'fs_write', args: { path: 'mutable.txt', content: 'v2' } }],
    [{ name: 'fs_read', args: { path: 'mutable.txt' } }],
  ]);
  const { agent: agent2, store: store2 } = makeAgent(ws2, t2, provider2, {});
  try {
    await agent2.chat('读、写、再读', () => {});
    check('【关键】中间的写让缓存失效，第二次读真的重新读了',
      (counts2.get('fs_read') ?? 0) >= 2, JSON.stringify([...counts2]));
    const reads = agent2.getHistory().filter((m) => m.role === 'tool').map((m) => String(m.content));
    check('第二次读拿到的是写之后的内容（不是旧值）',
      reads[0].includes('v1') && reads[2].includes('v2'), JSON.stringify(reads));
  } finally {
    store2.close();
  }

  /*
   * And the cache does not outlive the turn: a new turn re-reads, because the user may have
   * edited the file (or another process may have) and nothing in this process would know.
   */
  const ws3 = freshDir('reuse-turn');
  writeFileSync(join(ws3, 'turn.txt'), 'x\n', 'utf8');
  const { tools: t3 } = makeTools(ws3, [], {});
  const counts3 = new Map();
  const base3 = t3.execute;
  t3.execute = async (name, args) => {
    counts3.set(name, (counts3.get(name) ?? 0) + 1);
    return base3(name, args);
  };
  const provider3 = scriptProvider([
    [{ name: 'fs_read', args: { path: 'turn.txt' } }],
    [{ name: 'fs_read', args: { path: 'turn.txt' } }],
  ]);
  const { agent: agent3, store: store3 } = makeAgent(ws3, t3, provider3, {});
  try {
    await agent3.chat('第一轮', () => {});
    const afterFirst = counts3.get('fs_read');
    agent3.provider = scriptProvider([
      [{ name: 'fs_read', args: { path: 'turn.txt' } }],
      [{ name: 'fs_read', args: { path: 'turn.txt' } }],
    ]);
    await agent3.chat('第二轮', () => {});
    check('【关键】缓存不跨轮：第二轮重新读了（用户可能在两轮之间改了文件）',
      afterFirst === 1 && counts3.get('fs_read') === 2, `first=${afterFirst} total=${counts3.get('fs_read')}`);
  } finally {
    store3.close();
  }
}

// ─── 8. 可重试失败多给一次（retryable 接进卡死检测） ──────────────────────────
console.log('\n=== 可重试的失败不该被当成原地打转 ===');
{
  const previousRepeat = process.env.SHE_REPEAT_LIMIT;
  process.env.SHE_REPEAT_LIMIT = '3';
  try {
    const roundsUntilNudge = async (result) => {
      const ws = freshDir('stall');
      const { tools } = makeTools(ws, [tool('flaky')], { flaky: async () => result });
      const provider = repeatProvider('flaky');
      const { agent, store } = makeAgent(ws, tools, provider, {});
      try {
        await agent.chat('一直重试', () => {});
      } finally {
        store.close();
      }
      // The nudge is pushed into the REQUEST only, so it shows up on the round after it fired.
      const at = provider.seen.findIndex((msgs) => msgs.some((m) => String(m.content).includes('[系统提示]')));
      return at < 0 ? Infinity : at + 1;
    };

    const transient = await roundsUntilNudge('Error: fetch failed');
    const permanent = await roundsUntilNudge('Error: 目标不存在');

    check('【关键】瞬时失败（服务不可达）比永久失败晚一轮才被当成卡住',
      transient > permanent, `瞬时=${transient} 永久=${permanent}`);
    check('永久失败在第 4 轮就提示（3 次相同结果 + 1 次看到提示）', permanent === 4, String(permanent));
    check('瞬时失败多给的那一次确实用掉了（第 5 轮才提示）', transient === 5, String(transient));
  } finally {
    if (previousRepeat === undefined) delete process.env.SHE_REPEAT_LIMIT;
    else process.env.SHE_REPEAT_LIMIT = previousRepeat;
  }
}

// ─── 9. 模块级不变量 ─────────────────────────────────────────────────────────
console.log('\n=== 模块级不变量 ===');
{
  const off = budgetStop(DEFAULT_BUDGET, { rounds: 1e6, toolCalls: 1e6, tokens: 1e9, elapsedSeconds: 1e6 });
  check('【关键】关着的时候，任何用量都不会触发', off === null, JSON.stringify(off));

  const armed = { ...DEFAULT_BUDGET, enabled: true, maxToolRounds: 1 };
  check('开着的时候，到上限即触发',
    budgetStop(armed, { rounds: 1, toolCalls: 0, tokens: 0, elapsedSeconds: 0 })?.kind === 'rounds', null);

  const text = renderBudgetStop({ kind: 'tool_calls', limit: 3, used: 3 });
  check('每个轴的停止文案都点名自己的配置键',
    ['tokens', 'seconds', 'rounds', 'tool_calls'].every((kind) =>
      /SHE_BUDGET_/.test(renderBudgetStop({ kind, limit: 1, used: 1 }))),
    text);

  check('parseBudgetLimits 对坏值退回默认（不产生 NaN）',
    parseBudgetLimits({ enabled: true, maxTokens: 'lots' }).maxTokens === 0, null);

  const prefix = readsToPrefetch(
    [{ name: 'fs_read', rawArgs: '{"path":"a"}' }, { name: 'fs_write', rawArgs: '{}' }, { name: 'fs_read', rawArgs: '{"path":"a"}' }],
    () => false,
  );
  check('【关键】预取只取开头连续的只读段（写之后的读留给串行路径）',
    prefix.length === 1 && prefix[0].index === 0, JSON.stringify(prefix.map((p) => p.index)));

  check('没见过的工具名默认串行',
    !isReadOnlyTool('plugin_thing') && !isReadOnlyTool('mcp__read_file'), null);
}

// ─── 10. 接线与文档 ──────────────────────────────────────────────────────────
console.log('\n=== 接线与文档 ===');
{
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  check('package.json 里有 check:budget', /scripts\/budget-check\.mjs/.test(pkg.scripts['check:budget'] ?? ''), pkg.scripts['check:budget']);
  check('check:offline 接进了 check:budget', /check:budget/.test(pkg.scripts['check:offline'] ?? ''), null);

  const agents = readFileSync(join(PROJECT_ROOT, 'AGENTS.md'), 'utf8');
  check('AGENTS.md 提到了这条检查', /check:budget/.test(agents), null);

  const testing = readFileSync(join(PROJECT_ROOT, 'docs/testing.md'), 'utf8');
  check('docs/testing.md 有这一行', /check:budget/.test(testing), null);

  const agentSrc = readFileSync(join(PROJECT_ROOT, 'packages/agent-runtime/src/agent.ts'), 'utf8');
  check('【关键】检查点都在「还没干活」的地方：跑下一轮之前、跑工具之前',
    /const roundStop = budgetStop\(budget, usageNow\(\)\)/.test(agentSrc)
      && /const spendStop = budgetStop\(budget, usageNow\(\{ rounds: 0 \}\)\)/.test(agentSrc)
      && /const callStop = budgetStop\(budget, usageNow\(\{ rounds: 0, tokens: 0 \}\)\)/.test(agentSrc), null);
  check('预算停止走的是独立收尾路径（不是 failTurn，不会被当成错误）',
    /private endTurnForBudget/.test(agentSrc)
      && /endTurnForBudget[\s\S]{0,900}?this\.runFailure = \{ reason: 'budget'/.test(agentSrc), null);
  check('被拦下的调用会补上 not_run，保证记录合法', /not_run: true/.test(agentSrc), null);
  check('缓存只在非只读调用后清空（保守：不是读就当它改了东西）',
    /if \(!isReadOnlyTool\(name\)\) readCache\.clear\(\)/.test(agentSrc), null);

  const example = readFileSync(join(PROJECT_ROOT, 'config.example.yaml'), 'utf8');
  check('config.example.yaml 里写明了默认关闭和 0 的含义',
    /budget:/.test(example) && /enabled: false/.test(example) && /0 on an axis means/.test(example), null);
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
