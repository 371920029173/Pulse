import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandMatches, createReflectionTools, detectDrift, prohibitionObject } from '../reflection.js';

const goal = 'verify the server restarted: pid 15884 replaced by 17856';

test('actions matching the current plan step are not drift', () => {
  const r = detectDrift({
    goal,
    currentStep: 'probe netstat port 5577 and lsp_definition on src/types.ts',
    actions: [
      { tool: 'shell', args: '{"command":"netstat -ano | findstr 5577"}' },
      { tool: 'lsp_definition', args: '{"path":"src/types.ts","line":1,"col":15}' },
      { tool: 'shell', args: '{"command":"netstat -ano"}' },
      { tool: 'lsp_definition', args: '{"path":"src/types.ts","line":1,"col":14}' },
      { tool: 'shell', args: '{"command":"netstat -a"}' },
    ],
  });
  assert.equal(r.signals.find((s) => s.kind === 'goal_unrelated'), undefined);
});

test('bookkeeping calls do not count as unrelated work', () => {
  const r = detectDrift({
    goal,
    actions: [
      { tool: 'shell', args: '{"command":"ps -p 17856"}' },
      { tool: 'plan_update', args: '{"id":"p1"}' },
      { tool: 'reflection_check', args: '{}' },
      { tool: 'errorbook_lookup', args: '{}' },
      { tool: 'memo_list', args: '{}' },
    ],
  });
  assert.equal(r.signals.find((s) => s.kind === 'goal_unrelated'), undefined);
});

test('work unrelated to both goal and step is still reported', () => {
  const r = detectDrift({
    goal,
    currentStep: 'probe netstat port 5577',
    actions: [
      { tool: 'fs_read', args: '{"path":"docs/marketing.md"}' },
      { tool: 'fs_read', args: '{"path":"docs/pricing.md"}' },
      { tool: 'web_fetch', args: '{"url":"https://example.com/blog"}' },
      { tool: 'fs_read', args: '{"path":"docs/brand.md"}' },
      { tool: 'fs_read', args: '{"path":"docs/logo.md"}' },
    ],
  });
  const s = r.signals.find((x) => x.kind === 'goal_unrelated');
  assert.ok(s);
  assert.equal(s!.major, true);
});

// Live run 2026-09-26 19:41: the model passed its own short labels and the check said drift 1.00.
const liveGoal = "复测上一轮仍未闭环的两项——reflection_check 假阳性与 lsp_diagnostics 超时（上轮在 qa/hard/geometry.ts 复现）——在新构建（PID 19300）下是否修复";
const liveStep = "s2 校验自检模块的判定品质";
const liveLabels = ["复查", "收尾", "读文件", "写文件", "清理草稿", "跑回归"];

test('labels with no tool are not judged as unrelated work', () => {
  const r = detectDrift({ goal: liveGoal, actions: liveLabels });
  assert.equal(r.signals.find((s) => s.kind === 'goal_unrelated'), undefined);
});

test('calling a bookkeeping tool the goal is about counts as on-topic', () => {
  const r = detectDrift({
    goal: liveGoal,
    currentStep: liveStep,
    actions: [
      { tool: 'reflection_check', args: '{}' },
      { tool: 'reflection_check', args: '{}' },
      { tool: 'lsp_diagnostics', args: '{"path":"qa/hard/geo-copy.ts"}' },
    ],
  });
  assert.equal(r.level, 'none');
});

test('a paraphrased step is not reported when the real calls are on the goal', () => {
  const r = detectDrift({
    goal: liveGoal,
    currentStep: liveStep,
    actions: [
      { tool: 'fs_read', args: '{"path":"src/a.ts"}' },
      { tool: 'lsp_diagnostics', args: '{"path":"qa/hard/geometry.ts"}' },
      { tool: 'shell', args: '{"command":"ps -p 19300"}' },
    ],
  });
  assert.equal(r.signals.find((s) => s.kind === 'step_off_goal'), undefined);
});

test('reflection_check judges the recorded calls, not the labels passed in', async () => {
  const tools = createReflectionTools({
    goal: () => liveGoal,
    constraints: () => [],
    actions: () => [
      { tool: 'shell', args: '{"command":"ps -p 19300"}' },
      { tool: 'lsp_diagnostics', args: '{"path":"qa/hard/geometry.ts"}' },
      { tool: 'reflection_check', args: '{}' },
      { tool: 'lsp_diagnostics', args: '{"path":"qa/hard/geo-copy.ts"}' },
      { tool: 'fs_read', args: '{"path":"qa/hard/geometry.ts"}' },
    ],
    currentStep: () => liveStep,
    budget: () => ({ used: 5, limit: 32 }),
    calibration: () => ({ samples: 0 }) as never,
  });
  const text = await tools.execute('reflection_check', { actions: [...liveLabels, ...liveLabels], current_step: liveStep });
  assert.doesNotMatch(text, /1\.00/);
  assert.doesNotMatch(text, /最近 \d 个动作/);
});

const kbRule = '不得直读 .she/kb.sqlite，只用 kb_* 工具';

test('a whitelist in a constraint is not read as the forbidden object', () => {
  for (const rule of [kbRule, '不得直读 .she/kb.sqlite 只用 kb_* 工具', 'never read .she/kb.sqlite; only use kb_* tools']) {
    const r = detectDrift({
      goal: 'record the QA findings in the knowledge base',
      constraints: [rule],
      actions: [
        { tool: 'kb_upsert', args: '{"title":"qa","content":"x"}' },
        { tool: 'kb_query', args: '{"query":"geometry"}' },
      ],
    });
    assert.equal(r.signals.find((x) => x.kind === 'constraint_violated'), undefined, rule);
  }
});

test('the prohibited half of a whitelisted constraint is still enforced', () => {
  const r = detectDrift({
    goal: 'record the QA findings in the knowledge base',
    constraints: [kbRule],
    actions: [{ tool: 'shell', args: '{"command":"sqlite3 .she/kb.sqlite .tables"}' }],
  });
  assert.ok(r.signals.find((x) => x.kind === 'constraint_violated'));
});

/*
 * Tester round R7 (rate 1.00): a constraint that NAMES A TOOL in order to prescribe it — "用 shell
 * 跑测试", "改用 fs_patch", "must call kb_query first", "不要跳过 kb_query" — had that tool read as the
 * forbidden object, so every obedient call to it was reported as a violation.
 */
const sh = (command: string) => JSON.stringify({ command });
const kbq = JSON.stringify({ query: 'conventions' });
const violated = (constraint: string, tool: string, args: string) => detectDrift({
  goal: 'fix the flaky login test',
  constraints: [constraint],
  actions: [{ tool, args }],
}).signals.some((s) => s.kind === 'constraint_violated');

test('a tool the constraint prescribes is not its forbidden object', () => {
  const cases: [string, string, string][] = [
    ['用 shell 跑测试，不要用 fs_write', 'shell', sh('pnpm test')],
    ['测试用 shell 跑，不要用 fs_write 写临时文件', 'shell', sh('pnpm test')],
    ['通过 shell 跑测试，不要用 fs_write', 'shell', sh('pnpm test')],
    ['不要用 fs_write，改用 fs_patch', 'fs_patch', '{"path":"src/a.ts"}'],
    ['不要用 fs_write 改用 fs_patch', 'fs_patch', '{"path":"src/a.ts"}'],
    ['调用 kb_query 检索，不得直读 .she/kb.sqlite', 'kb_query', kbq],
    ['必须先调用 kb_query，不要直接改代码', 'kb_query', kbq],
    ['不要跳过 kb_query', 'kb_query', kbq],
    ['不要绕过 kb_query 直接读 .she/kb.sqlite', 'kb_query', kbq],
    ['除 shell 外不要用其他工具', 'shell', sh('ls')],
    ['shell 是唯一可用的工具，不要用别的', 'shell', sh('ls')],
    ['use shell to run tests, never use fs_write', 'shell', sh('pnpm test')],
    ["don't use fs_write, use fs_patch instead", 'fs_patch', '{"path":"src/a.ts"}'],
    ['never use fs_write but use fs_patch', 'fs_patch', '{"path":"src/a.ts"}'],
    ['must call kb_query first and never read .she/kb.sqlite directly', 'kb_query', kbq],
    ['must call kb_query first, do not read .she/kb.sqlite directly', 'kb_query', kbq],
    ['do not edit files without calling kb_query first', 'kb_query', kbq],
    ["don't skip kb_query", 'kb_query', kbq],
    ['never use any tool other than shell', 'shell', sh('ls')],
    ['only use git via shell, never call the git tool', 'shell', sh('git status')],
    ['run git via shell; do not use fs_write on .git', 'shell', sh('git log')],
  ];
  for (const [rule, tool, args] of cases) assert.equal(violated(rule, tool, args), false, `${rule} -> ${tool}`);
});

test('the prohibited tool in a tool-naming constraint is still flagged', () => {
  const cases: [string, string, string][] = [
    ['不要用 shell', 'shell', sh('ls')],
    ['never use fs_write', 'fs_write', '{"path":"src/a.ts"}'],
    ['用 shell 跑测试，不要用 fs_write', 'fs_write', '{"path":"src/a.ts"}'],
    ['不要用 fs_write，改用 fs_patch', 'fs_write', '{"path":"src/a.ts"}'],
    ['不要用 fs_write 改用 fs_patch', 'fs_write', '{"path":"src/a.ts"}'],
    ["don't use fs_write, use fs_patch instead", 'fs_write', '{"path":"src/a.ts"}'],
    ['must call kb_query first and never read .she/kb.sqlite directly', 'shell', sh('sqlite3 .she/kb.sqlite .tables')],
    ['不要绕过 kb_query 直接读 .she/kb.sqlite', 'shell', sh('sqlite3 .she/kb.sqlite .tables')],
    ['先用 kb_query 查规范，不要改 cluster.ts', 'fs_write', '{"path":"src/cluster.ts"}'],
    ['不要跳过 kb_query，不要改 cluster.ts', 'fs_write', '{"path":"src/cluster.ts"}'],
    ['only use git via shell, never call the git tool', 'git', '{"op":"status"}'],
    ['use shell, never git push --force', 'shell', sh('git push --force')],
    ['run git via shell; do not use fs_write on .git', 'fs_write', '{"path":".git/config"}'],
    ['子代理不得用 `shell`、`fs_*`、`git` 等工具', 'shell', sh('ls')],
  ];
  for (const [rule, tool, args] of cases) assert.equal(violated(rule, tool, args), true, `${rule} -> ${tool}`);
});

test('a tool-naming constraint does not flag unrelated calls, and nouns are not read as use-verbs', () => {
  assert.equal(violated('用 shell 跑测试，不要用 fs_write', 'kb_query', kbq), false);
  assert.equal(violated('never use fs_write', 'fs_read', '{"path":"src/a.ts"}'), false);
  // "用户" / "调用方" / "删除" contain 用 / 调用 / 除 but are not "use" / "except": the object stays.
  assert.equal(violated('不要动 a.ts，用户配置也不要动', 'fs_write', '{"path":"a.ts"}'), true);
  assert.equal(violated('调用方的代码不要改', 'fs_write', '{"path":"调用方的代码/x.ts"}'), true);
  assert.equal(violated('不要用 shell 删除 packages/migrations', 'fs_write', '{"path":"packages/migrations/1.sql"}'), true);
});

// Reviewer round after R7: missed true positives, allow-lists, tool names vs arguments, descriptions.
test('colloquial prohibitions are prohibitions', () => {
  for (const rule of ['别用 fs_write', '别使用 fs_write', '勿用 fs_write', '请勿使用 fs_write', '不允许用 fs_write', '禁止使用 fs_write', "you can't use fs_write"]) {
    assert.equal(violated(rule, 'fs_write', '{"path":"src/a.ts"}'), true, rule);
    assert.equal(violated(rule, 'fs_read', '{"path":"src/a.ts"}'), false, rule);
  }
  assert.equal(violated('千万别碰 cluster.ts', 'fs_write', '{"path":"src/cluster.ts"}'), true);
  // "别的" is "other", not "don't": a prescription that says "use another tool" is not a prohibition.
  assert.equal(violated('用别的工具跑测试', 'shell', sh('pnpm test')), false);
});

test('an allow-list flags every other tool, but not the allowed one, its family or bookkeeping', () => {
  const rules = ['只用 shell，不要用别的工具', 'shell 是唯一可用的工具', 'shell 是唯一可用的工具，不要用别的',
    '除 shell 外不要用其他工具', '不要用 shell 以外的工具', 'only use shell', 'never use any tool other than shell'];
  for (const rule of rules) {
    assert.equal(violated(rule, 'fs_write', '{"path":"a.ts"}'), true, `${rule} -> fs_write`);
    for (const [tool, args] of [['shell', sh('ls')], ['shell_wait', '{"id":"job_1"}'], ['plan_update', '{"plan_id":"p"}'], ['report_write', '{"title":"t"}']]) {
      assert.equal(violated(rule, tool, args), false, `${rule} -> ${tool}`);
    }
  }
  assert.equal(violated('只用 kb_query', 'shell', sh('sqlite3 .she/kb.sqlite .tables')), true);
  assert.equal(violated('只用 kb_query', 'kb_query', kbq), false);
  const r = detectDrift({ goal: 'x', constraints: ['只用 shell，不要用别的工具'], actions: [{ tool: 'fs_write', args: '{"path":"a.ts"}' }] });
  assert.match(r.signals[0].detail, /排除的对象「fs_write」出现在了 fs_write 的调用参数里/);
});

test('a whitelist scoped to its own prohibition or task is not a global allow-list', () => {
  assert.equal(violated(kbRule, 'fs_read', '{"path":"src/a.ts"}'), false);
  assert.equal(violated(kbRule, 'kb_upsert', '{"title":"t"}'), false);
  assert.equal(violated('只用 shell 跑测试，不要用 fs_write', 'fs_read', '{"path":"src/a.ts"}'), false);
  assert.equal(violated('only use git via shell', 'fs_read', '{"path":"src/a.ts"}'), false);
  assert.equal(violated('只用 utf-8 编码', 'fs_write', '{"path":"a.ts"}'), false);
});

test('a forbidden tool name is compared with the called tool, not with arguments', () => {
  assert.equal(violated('用 shell 跑测试，不要用 fs_write', 'shell', sh('cat docs/fs_write.md')), false);
  assert.equal(violated('不要用 shell', 'fs_read', '{"path":"src/shell/index.ts"}'), false);
  assert.equal(violated('不要用 shell', 'shell', sh('ls')), true);
  assert.equal(violated('不要用 shell', 'shell_wait', '{"id":"job_1"}'), true);
  // Non-tool objects still match the target arguments.
  assert.equal(violated('禁止 git push --force', 'shell', sh('git push --force')), true);
  assert.equal(violated('不要用 git', 'shell', sh('git commit -m x')), true);
  assert.equal(violated('不要改 .git', 'shell', sh('rm -rf .git/hooks')), true);
  assert.equal(violated('不要改 .git', 'shell', sh('git status')), false);
});

test('the registered tool list decides what is a tool name', () => {
  const run = (toolNames?: string[]) => detectDrift({
    goal: 'x', constraints: ['不要用 git'], toolNames, actions: [{ tool: 'shell', args: sh('git status') }],
  }).signals.some((s) => s.kind === 'constraint_violated');
  // Without a `git` tool, "git" is a command and a shell command line running it breaks the rule.
  assert.equal(run(), true);
  // With a registered `git` tool, "不要用 git" forbids that tool; the shell call is something else.
  assert.equal(run(['shell', 'git', 'fs_read']), false);
});

test('the subject or description in front of a prohibition is not its object', () => {
  // portability-check:allow — 被测数据：约束原句里点名解释器，不是要执行它。
  assert.equal(violated('shell 由 cmd.exe 解析，不能用 POSIX 写法', 'shell', sh('dir')), false);
  assert.equal(violated('shell 不能用 POSIX 写法', 'shell', sh('dir')), false);
  assert.equal(violated('本工作区非 git 仓库、无 package.json，worktree 隔离与依赖扫描不可用，须如实标注不得报 clean', 'fs_read', '{"path":"package.json"}'), false);
  // A topicalised object with nothing concrete after the prohibition word is still the object.
  assert.equal(violated('a.ts 不要改', 'fs_write', '{"path":"a.ts"}'), true);
  assert.equal(violated('a.ts 不要改，b.ts 也不要改', 'fs_write', '{"path":"a.ts"}'), true);
  assert.equal(violated('x.ts 是生成的，不要改它', 'fs_write', '{"path":"src/x.ts"}'), true);
  assert.equal(violated('cluster.ts 别动', 'fs_write', '{"path":"src/cluster.ts"}'), true);
});
/*
 * Reviewer, round 3: five pre-existing matching bugs. Each test has both directions.
 */
test('objects are compared case-insensitively, path separators folded', () => {
  assert.equal(violated('不要改 README.md', 'fs_write', '{"path":"README.md"}'), true);
  assert.equal(violated('不要改 README.md', 'fs_write', '{"path":"docs/readme.md"}'), true);
  assert.equal(violated('never touch DENIED.log', 'fs_write', '{"path":"logs/denied.log"}'), true);
  assert.equal(violated('不要改 README.md', 'fs_write', '{"path":"src/a.ts"}'), false);
  assert.equal(violated('不要改 packages/migrations', 'shell', sh('del /s /q packages\\migrations')), true);
});

test('an un-backticked command is one object, matched as a command', () => {
  assert.deepEqual(prohibitionObject('不要用 rm -rf'), ['rm -rf']);
  assert.deepEqual(prohibitionObject('never run rm -rf on the repo'), ['rm -rf']);
  assert.equal(violated('不要用 rm -rf', 'shell', sh('rm -rf x')), true);
  assert.equal(violated('never run rm -rf', 'shell', sh('rm -fr build')), true);
  assert.equal(violated('never run rm -rf', 'shell', sh('rm -r -f build')), true);
  assert.equal(violated('never run rm -rf on the repo', 'shell', sh('cd x && rm -rf dist')), true);
  assert.equal(violated('never run rm -rf', 'shell', sh('rm x.txt')), false);
  assert.equal(violated('不要用 rm -rf', 'fs_read', '{"path":"docs/rm.md"}'), false);
  assert.equal(violated('不要 npm publish', 'shell', sh('npm publish --access public')), true);
  assert.equal(violated('不要 npm publish', 'shell', sh('npm install')), false);
  // "never cat files" has no flag and cat takes no subcommand: not a command phrase.
  assert.notDeepEqual(prohibitionObject('never cat files'), ['cat files']);
});

test('a command object matches its tokens in order within one command, flags by name or alias', () => {
  const rule = '不要 git push --force';
  assert.deepEqual(prohibitionObject(rule), ['git push --force']);
  assert.equal(violated(rule, 'shell', sh('git push --force')), true);
  assert.equal(violated(rule, 'shell', sh('git push origin main --force')), true);
  assert.equal(violated(rule, 'shell', sh('git push -f origin main')), true);
  assert.equal(violated(rule, 'shell', sh('git push origin main')), false);
  assert.equal(violated(rule, 'shell', sh('git push --force-with-lease')), false);
  // --force on another command in the same line is not this command's flag.
  assert.equal(violated(rule, 'shell', sh('git fetch --force && git push origin main')), false);
  assert.equal(violated('不要 `git push --force`', 'shell', sh('git push origin --force')), true);
  assert.equal(violated('不要 `git push --force`', 'shell', sh('git push origin main')), false);
  assert.equal(violated('不要 git reset --hard', 'shell', sh('git reset --soft HEAD~1')), false);
  assert.equal(violated('不要 git reset --hard', 'shell', sh('git reset --hard HEAD~1')), true);
  assert.equal(commandMatches('{"command":"rm --recursive --force x"}', 'rm -rf'), true);
  assert.equal(commandMatches('{"command":"echo rm -rf"}', 'rm -rf'), true);
  assert.equal(commandMatches('{"command":"git push origin main"}', 'git push --force'), false);
});

test('a tool used ON an object: the object is what is forbidden, the tool alone is not', () => {
  for (const rule of ['do not use fs_write on .git', '不要在 .git 里用 fs_write', 'never touch .git with fs_write']) {
    assert.equal(violated(rule, 'fs_write', '{"path":"src/a.ts"}'), false, rule);
    assert.equal(violated(rule, 'fs_write', '{"path":".git/HEAD"}'), true, rule);
  }
  assert.equal(violated('不要用 fs_write 改 README.md', 'fs_write', '{"path":"src/a.ts"}'), false);
  assert.equal(violated('不要用 fs_write 改 README.md', 'fs_write', '{"path":"README.md"}'), true);
  assert.equal(violated('never use git via shell', 'shell', sh('pnpm test')), false);
  assert.equal(violated('never use git via shell', 'shell', sh('git log')), true);
  // Two prohibitions are not a scope: the bare tool is still forbidden on its own.
  assert.equal(violated('不要用 fs_write，也不要改 .git', 'fs_write', '{"path":"src/a.ts"}'), true);
  assert.equal(violated('never use fs_write', 'fs_write', '{"path":"src/a.ts"}'), true);
  // 「不要用 shell 删除 X」: deleting X is still caught (any tool touching X, as before); shell alone is not.
  const del = '不要用 shell 删除 packages/migrations';
  assert.equal(violated(del, 'shell', sh('rm -rf packages/migrations')), true);
  assert.equal(violated(del, 'shell', sh('rd /s /q packages\\migrations')), true);
  assert.equal(violated(del, 'fs_write', '{"path":"packages/migrations/1.sql"}'), true);
  assert.equal(violated(del, 'shell', sh('pnpm test')), false);
  assert.equal(violated('不要用 shell 执行 rm -rf', 'shell', sh('rm -rf dist')), true);
  assert.equal(violated('不要用 shell 执行 rm -rf', 'shell', sh('ls')), false);
});

test('"X 的 Y" / "X\'s Y" / "Y of X" with X a tool forbids Y; X is context', () => {
  assert.equal(violated('不要用 shell 的 POSIX 写法', 'shell', sh('dir')), false);
  assert.equal(violated('不要用 shell 的 POSIX 写法', 'shell', sh('POSIX=1 ls')), true);
  assert.equal(violated("don't use shell's POSIX syntax", 'shell', sh('dir')), false);
  assert.equal(violated('never use the POSIX syntax of shell', 'shell', sh('dir')), false);
  // A file's part is still the file: changing cluster.ts's exports changes cluster.ts.
  assert.equal(violated('别改 cluster.ts 的导出', 'fs_write', '{"path":"src/cluster.ts"}'), true);
});
