/**
 * The error book — offline, no API calls, no ports.
 *
 * The book is a WRITE path into the knowledge base, which makes it the kind of feature that
 * passes forever while doing nothing: a lookup returns `[]`, a count reads `0`, and both look
 * exactly like "nothing has gone wrong yet". So this check does not restate the book's rules.
 * It drives the real tools, classifies what they actually returned, and then reads the real
 * SQLite rows back to see what was written where:
 *
 *   1. Real failures from real tools → real rows under `errors/<tool>`.
 *   2. A repeat of the same failure → one row, count 2.
 *   3. A fact in the KB → NOT an entry, even when its text matches the query.
 *   4. A real Agent turn → the loop's own recording path, including a stuck loop.
 *   5. Pre-flight → the book's contents reach the analysis.
 *   6. Retirement → an entry can be taken out of circulation with a reason, and a repeat
 *      puts it back.
 *
 * Sections 4 and 5 are the ratchet: they fail if the agent stops handing failures to the book,
 * which is the only way this feature can be silently lost.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../packages/shared/dist/index.js';
import { KBStore, GroupKBEngine } from '../packages/kb/dist/index.js';
import { SandboxShell, createTools } from '../packages/sandbox/dist/index.js';
import {
  Agent,
  ErrorBook,
  ERRORBOOK_ROOT,
  createErrorbookTools,
  createPreflightTools,
  classifyToolResult,
  isWorthRemembering,
  formatErrorEntry,
} from '../packages/agent-runtime/dist/index.js';
import { removeTempDir } from './lib/temp.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';
const dir = mkdtempSync(join(tmpdir(), 'she-errorbook-'));
mkdirSync(join(dir, '.she'), { recursive: true });
writeFileSync(join(dir, 'present.ts'), 'export const a = 1;\n', 'utf8');

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

const store = new KBStore(join(dir, 'kb.sqlite'));
const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(dir, 'kb.sqlite') });
const shell = new SandboxShell(dir, cfg.sandbox);
const sandboxTools = createTools(shell, dir, { allowAllCommands: true });

/*
 * The engine and the store are passed separately because that is where the two halves of the
 * KB live: the engine owns group maintenance and retrieval, the store owns the rows. The
 * agent does the same thing (see `agent.ts`).
 */
const book = new ErrorBook(engine, store);

/** Run one real tool and return the string the agent would classify. */
async function run(toolset, name, args) {
  try {
    return await toolset.execute(name, args);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** Every row the book could have written, read back from SQLite rather than from the object. */
function errorRows() {
  const root = store.getAllGroups().find((g) => g.name === ERRORBOOK_ROOT && !g.parentGroupId);
  if (!root) return [];
  return store.getAllGroups()
    .filter((g) => g.parentGroupId === root.id)
    .flatMap((g) => store.getMemoriesByGroup(g.id));
}

const NO_MATCH = 'zzz_no_such_symbol_zzz';

// ─── 1. 真实失败 → 真的落库 ─────────────────────────────────────────────────
console.log('\n=== 真实工具失败 → 真的写进 KB ===');
{
  /*
   * `cmd /c exit 3` is a Windows built-in; on POSIX `/bin/sh` answers `cmd: not found` and exits
   * 127. That is *also* non-zero, so this case passed on Linux for the wrong reason — it asserted
   * "some non-zero exit" while its label claimed `exit 3`. Spelled per platform so the number
   * really is the one the command produced.
   */
  const exit3 = IS_WINDOWS ? 'cmd /c exit 3' : 'exit 3';
  const cases = [
    ['shell 非零退出码', 'shell', { command: exit3 }, 'nonzero_exit'],
    ['fs_read 文件不存在', 'fs_read', { path: 'nope/missing.ts' }, 'not_found'],
    ['fs_read 工作区外', 'fs_read', { path: '../../../etc/passwd' }, 'permission'],
    ['未知工具', 'definitely_not_a_tool', {}, 'unavailable'],
    ['grep 无匹配', 'grep', { pattern: NO_MATCH }, 'empty'],
  ];

  let recordable = 0;
  for (const [label, name, args, expected] of cases) {
    const raw = await run(sandboxTools, name, args);
    const v = classifyToolResult(name, raw);
    check(`${label} → ${expected}`, v.kind === expected,
      `实际 ${v.kind}\n原始返回: ${String(raw).slice(0, 200)}`);

    /*
     * The gate the agent uses, not a restatement of it. If `isWorthRemembering` ever starts
     * admitting weather (`timeout`, `service`), the count assertion below fails rather than
     * the book quietly filling up with network noise.
     */
    if (!isWorthRemembering(v.kind)) continue;
    recordable++;
    const { entry } = book.record({
      tool: name,
      kind: v.kind,
      call: JSON.stringify(args),
      detail: raw,
      remedy: v.remedy,
      sessionId: 'sess-1',
    });
    check(`  ${label} 落到 errors/${name}`,
      entry.group === `${ERRORBOOK_ROOT}/${name}` && entry.count === 1, entry.group);
  }

  check('只记了「做错了」的那些', book.count() === recordable,
    `条数 ${book.count()}，应记 ${recordable}`);
  check('grep 的空结果没被记成错误', book.lookup({ tool: 'grep' }).length === 0);

  const rows = errorRows();
  check('每条都是 tool_outcome，不是 fact', rows.length === recordable
    && rows.every((r) => r.kind === 'tool_outcome'),
    rows.map((r) => r.kind).join(', '));
  check('正文写清了工具/类型/次数', rows.every((r) => /工具：.+失败类型：.+出现次数：\d+/s.test(r.content)),
    rows[0]?.content);
  check('去路跟着一起存下来', rows.some((r) => r.metadata.errorRemedy));
}

// ─── 2. 重复 ────────────────────────────────────────────────────────────────
console.log('\n=== 同一个失败再来一次 ===');
{
  const report = {
    tool: 'shell',
    kind: 'nonzero_exit',
    call: 'cmd /c exit 7',
    detail: 'stdout:\nboom\nexit code: 7',
    remedy: '看 stderr',
    sessionId: 'sess-2',
  };
  const first = book.record(report);
  const before = errorRows().length;
  const second = book.record(report);

  check('第二次算重复，不是新纪录', second.recurring === true && second.entry.id === first.entry.id);
  check('计数加到 2', second.entry.count === 2);
  check('节点没有变成两条', errorRows().length === before);
  check('重复是「这条重要」的证据，会被提升',
    (store.getMemory(first.entry.id)?.accessCount ?? 0) >= 1,
    `accessCount=${store.getMemory(first.entry.id)?.accessCount}`);
  check('标题里能看到次数', /2 次/.test(store.getMemory(first.entry.id)?.title ?? ''),
    store.getMemory(first.entry.id)?.title);
  check('正文里也是写下的计数', /出现次数：2/.test(store.getMemory(first.entry.id)?.content ?? ''));
}

// ─── 3. 知识库里的普通笔记不是错题 ──────────────────────────────────────────
console.log('\n=== 不把知识库的普通内容当成错题 ===');
{
  /*
   * A fact group whose text shares nothing with the book. The point is the FILTER: this node
   * is a legitimate KB-wide retrieval hit for the token below, so if the book answered with it
   * the model would be told it had failed at something it has never attempted.
   */
  const notes = engine.createGroup('notes');
  const fact = engine.addMemoryMaintained(
    notes.id,
    'fact',
    'ZONK_TOKEN 的说明',
    'ZONK_TOKEN 是一个只存在于这条笔记里的记号。',
    {},
  );

  const kbHit = engine.query('ZONK_TOKEN').nodes.some((n) => n.id === fact.id);
  check('这个记号在知识库里确实查得到（过滤不是空转）', kbHit);

  const bookHit = book.lookup({ query: 'ZONK_TOKEN' });
  check('但错题本不会把它当成自己的记录', bookHit.length === 0,
    JSON.stringify(bookHit.map((e) => `${e.group}:${e.detail}`)));
  check('不带条件的查询也不会带上它',
    !book.lookup({ limit: 100 }).some((e) => e.detail.includes('ZONK_TOKEN')));
}

// ─── 4. 查询语义 ────────────────────────────────────────────────────────────
console.log('\n=== 查询 ===');
{
  const shells = book.lookup({ tool: 'shell' });
  check('按工具查只返回该工具的', shells.length > 0
    && shells.every((e) => e.group === `${ERRORBOOK_ROOT}/shell`),
    JSON.stringify(shells.map((e) => e.group)));
  check('次数多的排前面', shells[0]?.count === 2 && /boom/.test(shells[0]?.detail ?? ''),
    JSON.stringify(shells.map((e) => [e.count, e.detail.slice(0, 20)])));

  const all = book.lookup({ limit: 100 });
  check('不带条件按时间倒序，最新的在前',
    all.length > 1 && all[0].lastSeenAt >= all[all.length - 1].lastSeenAt,
    `${all[0]?.lastSeenAt} … ${all[all.length - 1]?.lastSeenAt}`);
  check('limit 生效', book.lookup({ limit: 1 }).length === 1 && book.lookup({ limit: 2 }).length === 2);
  check('查不存在的工具返回空，不是全部', book.lookup({ tool: 'never_used_at_all' }).length === 0);
}

// ─── 5. 接进真实 Agent ──────────────────────────────────────────────────────
console.log('\n=== 接进真实 Agent ===');
{
  const before = book.count();

  const defs = [
    { name: 'bad_command', description: 'A command that fails.', parameters: { type: 'object', properties: {}, required: [] } },
    { name: 'quiet_lookup', description: 'A search with no matches.', parameters: { type: 'object', properties: {}, required: [] } },
    { name: 'repeat_forever', description: 'Always returns the same thing.', parameters: { type: 'object', properties: {}, required: [] } },
  ];
  const execute = async (name) => {
    if (name === 'bad_command') return 'stdout:\nboom\nexit code: 3';
    if (name === 'quiet_lookup') return 'No matches found';
    return 'the file is not there';
  };

  const call = (name) => ({ name, args: {} });
  let step = 0;
  /** Round 1 fails once and searches once; rounds 2-5 are the same call with the same result. */
  const rounds = [
    [call('bad_command'), call('quiet_lookup')],
    [call('repeat_forever')],
    [call('repeat_forever')],
    [call('repeat_forever')],
    [call('repeat_forever')],
  ];
  let toolsSeen = null;
  const provider = {
    name: 'stub',
    async chat(messages, tools) {
      if (tools) toolsSeen = tools;
      const calls = rounds[step];
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

  const agent = new Agent(
    { ...cfg, llm: { ...cfg.llm, model: 'stub' }, sandbox: { ...cfg.sandbox, allowAllCommands: true } },
    engine,
    { definitions: defs, execute },
    null,
    {},
  );
  agent.provider = provider;

  await agent.chat('先跑个命令，再反复试一次同样的事', () => {});

  const after = book.count();
  check('一次真实回合计入了「做错了」的那些', after === before + 2,
    `before=${before} after=${after}：${JSON.stringify(book.lookup({ limit: 10 }).map((e) => [e.tool, e.kind, e.count]))}`);
  check('失败的命令被写进错题本',
    book.lookup({ tool: 'bad_command' }).some((e) => e.kind === 'nonzero_exit'));
  check('没结果的搜索没被写进去（那不是做错）', book.lookup({ tool: 'quiet_lookup' }).length === 0);
  check('卡住的循环按 stuck_loop 记下',
    book.lookup({ tool: 'repeat_forever' }).some((e) => e.kind === 'stuck_loop'),
    JSON.stringify(book.lookup({ tool: 'repeat_forever' })));

  check('错题本工具对模型可见',
    Array.isArray(toolsSeen) && toolsSeen.some((d) => d.name === 'errorbook_lookup'),
    Array.isArray(toolsSeen) ? toolsSeen.map((d) => d.name).join(', ') : '没有拿到工具表');

  /*
   * The tool set is read-only plus retirement, and both halves are the assertion.
   *
   * Read-only matters because a model that can write its own lessons fills the book with plausible
   * things nobody ever observed. Retirement matters because without it the only way to get rid of a
   * wrong entry is to stop reading the book — which throws away the true entries with the false one.
   * What must NOT exist is a tool that CREATES an entry, so the set is asserted by name rather than
   * by count: adding a third tool has to be a deliberate edit here, not something a count absorbs.
   */
  const bookTools = createErrorbookTools(book);
  const toolNames = bookTools.definitions.map((d) => d.name).sort().join(', ');
  check('错题本只有查询 + 退役两个工具，没有能创建条目的工具',
    toolNames === 'errorbook_forget, errorbook_lookup', toolNames);

  const answer = await run(bookTools, 'errorbook_lookup', { tool: 'bad_command' });
  check('查得到刚刚那次失败，并且带上去路', /bad_command/.test(answer) && /去路/.test(answer),
    answer.slice(0, 300));
  const nothing = await run(bookTools, 'errorbook_lookup', {});
  check('两个条件都不给是用法错误，不是空结果',
    classifyToolResult('errorbook_lookup', nothing).kind === 'invalid_args',
    `${classifyToolResult('errorbook_lookup', nothing).kind}\n${nothing}`);
}

// ─── 5b. 退役：踩错的能撤掉，撤掉的复发会自己回来 ────────────────────────────

/*
 * The case this exists for is a false alarm that a user cannot argue with: a failing test that was
 * failing on purpose, or a reflection that read a knowledge-base retrieval as a drifting tool call.
 * Measured on a live run: four such entries, and no way to retire any of them.
 *
 * The assertion that matters is the pair. Retiring and hiding are only correct TOGETHER — an entry
 * that can be hidden and never comes back is a way to lose a real lesson permanently, so the second
 * half (a repeat clears the retirement) is what makes the first half safe.
 */
console.log('\n=== 退役一条错题 ===');

{
  const tools = createErrorbookTools(book);
  /*
   * A tool name nothing else in this file uses.
   *
   * The first version used `shell`, which section 2 has already written two entries under — and
   * `lookup({ tool })` then returns a SET, so "the entry" was whichever sorted first. The failure
   * it produced (`reopened: false` while the count went up) pointed at the fixture, not the code.
   * One tool, one entry, no ordering to depend on.
   */
  const PROBE = 'retire_probe';
  book.record({ tool: PROBE, kind: 'nonzero_exit', detail: 'test failed on purpose', sessionId: 's-retire' });
  const before = book.lookup({ tool: PROBE });
  check('前提：这本书里有一条该工具的失败记录', before.length === 1, JSON.stringify(before));
  const entry = before[0];

  const gone = await run(tools, 'errorbook_forget', { id: entry.id, reason: '有意为之的失败测试' });
  check('退役成功并回执说明了原因', /有意为之/.test(gone), gone.slice(0, 300));
  check('退役后查询不再返回它', book.lookup({ tool: PROBE }).length === 0,
    JSON.stringify(book.lookup({ tool: PROBE })));
  check('【关键】退役不是删除 —— 行还在，理由和信号都在', (() => {
    const row = store.getMemory(entry.id);
    return Boolean(row) && row.metadata?.errorForgotten === true
      && row.metadata?.errorForgottenReason === '有意为之的失败测试';
  })(), JSON.stringify(store.getMemory(entry.id)?.metadata));

  // The half that makes retirement safe: it is not a permanent mute.
  const again = book.record({ tool: PROBE, kind: 'nonzero_exit', detail: 'test failed on purpose', sessionId: 's-retire' });
  const back = book.lookup({ tool: PROBE });
  check('【关键】同样的失败再来一次，退役被撤销（静音是永久的就没人敢用）',
    again?.reopened === true && back.some((e) => e.id === entry.id),
    JSON.stringify({ reopened: again?.reopened, seen: back }));
  check('撤销后计数继续累计，而不是从头开始',
    (back.find((e) => e.id === entry.id)?.count ?? 0) >= 2, JSON.stringify(back));
  check('撤销后元数据里的退役标记被清掉（否则查询会继续把它藏起来）',
    store.getMemory(entry.id)?.metadata?.errorForgotten !== true,
    JSON.stringify(store.getMemory(entry.id)?.metadata));

  const missing = await run(tools, 'errorbook_forget', { id: 'no-such-id' });
  check('退一条不存在的 id 是明确的失败，不是静默成功',
    /没有 id 为/.test(missing), missing.slice(0, 200));
}

// ─── 6. 开工前会去查 ────────────────────────────────────────────────────────
console.log('\n=== 预检带上已知错误 ===');
{
  book.record({
    tool: 'shell',
    kind: 'nonzero_exit',
    call: 'npm run build',
    detail: 'Error: EADDRINUSE: address already in use :::3000',
    remedy: '先杀掉占用端口的进程',
    sessionId: 'sess-4',
  });

  /*
   * The request points at a file that is not there (`@file:` is the marker the UI inserts when
   * the user picks something that exists, so this one resolves to a missing prerequisite). That
   * is what makes the ORDERING claim testable: known mistakes have to be stated before
   * prerequisites, because "you have hit this wall before" can change what the plan should even
   * be, whereas a missing file is a reason to go and create one.
   */
  const preflight = createPreflightTools(dir, {
    getRequest: () => '帮我修 @file:src/not-there.ts，之前老是 EADDRINUSE',
    listTools: () => ['shell', 'fs_read'],
    knownErrors: (q) => book.lookup({ query: q, limit: 3 }).map(formatErrorEntry),
  });
  const out = await run(preflight, 'preflight_record', {
    stated_intent: '修 src/not-there.ts',
    actual_goal: '让构建通过',
  });

  check('预检把错题本里的相关记录带上了', out.includes('错题本里相关的记录'), out.slice(0, 500));
  check('带上的是真实发生过的那条', /EADDRINUSE/.test(out), out.slice(0, 700));
  check('确实有前置条件可以比（否则顺序这句话是空转）', out.includes('前置条件'), out.slice(0, 700));
  check('已知错误排在推断出来的前置条件之前',
    out.indexOf('错题本里相关的记录') < out.indexOf('前置条件'),
    out.slice(0, 700));
}

// ─── 7. 写入范围 ────────────────────────────────────────────────────────────
console.log('\n=== 只在自己的子树下写东西 ===');
{
  const root = store.getAllGroups().find((g) => g.name === ERRORBOOK_ROOT && !g.parentGroupId);
  check('errors 根组存在且没有父组', Boolean(root) && root.parentGroupId === null);
  const strays = store.getAllGroups().filter(
    (g) => g.name !== ERRORBOOK_ROOT && g.parentGroupId !== root?.id && g.name !== 'notes',
  );
  check('知识库里没有多出别的组', strays.length === 0, strays.map((g) => g.name).join(', '));
  /*
   * The claim is "the book has no persistence of its own": every entry is a KB row, and there is
   * nothing in a file or a table that a reader would have to know about. Retired entries are rows
   * too, and `book.count()` deliberately excludes them (they are no longer lessons), so they are
   * added back here rather than dropped — a retired row that nothing accounted for would be a stray
   * the book did not write.
   */
  const rows = errorRows();
  const retired = rows.filter((m) => m.metadata?.errorForgotten === true).length;
  check('错题本没有自己的持久化文件（用的是 KB 原语）', rows.length === book.count() + retired,
    `rows=${rows.length} entries=${book.count()} retired=${retired}`);
}

store.close();
removeTempDir(dir);
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
