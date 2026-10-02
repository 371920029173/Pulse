/**
 * 评测框架本身 —— 离线，不调用任何 API。
 *
 *   node scripts/evals-check.mjs
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 两个评测（evals/agent、evals/verification）都按「通过率 + 门槛」判定，两次的运行日志里
 * 都写着同一句话：「先重跑一次确认是不是波动」。这句话本身是对的 —— 一次采样分不清
 *
 *   - **回归**：每次都挂，一定坏了；
 *   - **波动**：有时过有时不过，是判据不稳，不是能力回归。
 *
 * —— 但它把判断推给了人。这里钉住的是「把这句话变成机器能给结论」的那部分：
 * evals/lib/variance.mjs 的判定规则、evals/lib/tasks.mjs 的任务校验、以及两个 runner
 * 的 `--repeat` / `--dry-run` 真的接线了。
 *
 * 这些全是纯函数和 JSON 属性，不需要模型，也不需要网络 —— 所以它们能进离线门禁，
 * 而真正花钱的那两个评测不能。
 *
 * 代价：这个检查的价值全部来自「它能在评测失败之前就发现定义错了」，所以负例（错的
 * 任务定义）必须真的被判出来，不能只测正例。
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { hermeticEnv } from './lib/hermetic.mjs';
import { removeTempDir } from './lib/temp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const AGENT_TASKS = join(ROOT, 'evals', 'agent', 'tasks.json');
const VERIFY_TASKS = join(ROOT, 'evals', 'verification', 'tasks.json');

const { stats, verdict, summarize } = await import('../evals/lib/variance.mjs');
const { validateTasks, checksOf, turnCount, AGENT_CHECKS, VERIFY_CHECKS, loadTasks } =
  await import('../evals/lib/tasks.mjs');

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 700)}`);
  }
};

/** Build the flat sample list the harnesses produce. Each spec is "id:pass:id:pass:…". */
const samplesFrom = (...specs) => {
  const out = [];
  for (const spec of specs) {
    const parts = spec.split(':');
    for (let i = 0; i < parts.length; i += 2) {
      out.push({ id: parts[i], pass: parts[i + 1] === '1', ms: 100, tokens: 1000 });
    }
  }
  return out;
};

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 一次采样分不清回归和波动 —— 这正是要修的事
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n1. 单次采样：结论只能是「不确定」');

{
  const single = summarize(samplesFrom('a:0'), { threshold: 0.8 });
  const t = single.byTask[0];
  check('单次失败 → 判定 fail（如实说它没过）', t.verdict === 'fail', t.verdict);
  check('【关键】单次失败**不算**「每次都挂」—— 一次采样证明不了稳定性', single.dead.length === 0, JSON.stringify(single.dead.map((x) => x.id)));
  check('【关键】单次采样仍然按老规则走：0/1 < 门槛 → 门禁红（不能因为引入方差报告就放宽）',
    single.ok === false, JSON.stringify({ ok: single.ok, rate: single.totals.rate }));
  check('单次采样的重跑次数如实报 1', single.totals.repeats === 1, String(single.totals.repeats));

  const okSingle = summarize(samplesFrom('a:1', 'b:1'), { threshold: 0.8 });
  check('单次采样全部通过 → 门禁绿', okSingle.ok === true, JSON.stringify(okSingle.totals));

  const twoRuns = summarize(samplesFrom('a:0:a:0'), { threshold: 0.8 });
  check('【关键】只跑 2 遍都挂也不算「回归」—— 真有 80% 通过率的任务两次全挂约 4%',
    twoRuns.dead.length === 0, JSON.stringify(twoRuns.dead.map((x) => x.id)));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 多次采样：回归、波动、稳定通过要分得开
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n2. 三次采样：三种结论');

{
  const s = summarize(samplesFrom('stable:1:stable:1:stable:1', 'flaky:1:flaky:0:flaky:1', 'dead:0:dead:0:dead:0'), { threshold: 0.8 });
  const byId = Object.fromEntries(s.byTask.map((t) => [t.id, t]));
  check('3/3 → pass', byId.stable.verdict === 'pass' && byId.stable.passes === 3, JSON.stringify(byId.stable));
  check('2/3 → flaky（有时过有时不过）', byId.flaky.verdict === 'flaky' && byId.flaky.passes === 2, JSON.stringify(byId.flaky));
  check('0/3 → fail', byId.dead.verdict === 'fail' && byId.dead.passes === 0, JSON.stringify(byId.dead));
  check('【关键】波动不算回归：flaky 不进 dead 列表', s.dead.length === 1 && s.dead[0].id === 'dead', JSON.stringify(s.dead.map((x) => x.id)));
  check('波动被单独列出来（好让人去收紧判据）', s.flaky.length === 1 && s.flaky[0].id === 'flaky', JSON.stringify(s.flaky.map((x) => x.id)));

  /*
   * The hole a pass rate hides by construction: one task dead out of many still clears the floor.
   */
  const hidden = summarize(
    samplesFrom('t1:1:t1:1:t1:1', 't2:1:t2:1:t2:1', 't3:1:t3:1:t3:1', 't4:1:t4:1:t4:1', 'dead:0:dead:0:dead:0'),
    { threshold: 0.8 },
  );
  check('前提：平均值确实过了门槛', hidden.totals.rate >= 0.8, String(hidden.totals.rate));
  check('【关键】但有一个任务 3 次全挂 → 门禁还是红（平均值会盖掉一个死掉的工具）',
    hidden.ok === false, JSON.stringify({ ok: hidden.ok, rate: hidden.totals.rate, dead: hidden.dead.map((x) => x.id) }));

  const onlyFlaky = summarize(samplesFrom('a:1:a:1:a:1', 'b:1:b:0:b:1'), { threshold: 0.8 });
  check('【关键】只有波动、没有全挂 → 门禁仍然绿（波动不该拦发布，否则门禁会被学会忽略）',
    onlyFlaky.ok === true, JSON.stringify({ ok: onlyFlaky.ok, rate: onlyFlaky.totals.rate }));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 数字本身：均值、样本标准差、边界
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n3. 统计量与边界');

{
  const s = stats([2, 4, 4, 4, 5, 5, 7, 9]);
  check('均值正确', s.mean === 5, String(s.mean));
  check('样本标准差正确（总体标准差会偏小，判决会跟着变松）', Math.abs(s.sd - 2.1380899352993947) < 1e-9, String(s.sd));
  check('min/max 正确', s.min === 2 && s.max === 9, JSON.stringify(s));
  check('单样本的标准差是 0（不是 NaN）', stats([5]).sd === 0, String(stats([5]).sd));
  check('空数组得到全 0 而不是 NaN', stats([]).n === 0 && stats([]).mean === 0, JSON.stringify(stats([])));

  check('verdict(0,0) 不崩，且不报成通过', verdict(0, 0) !== 'pass', verdict(0, 0));
  check('通过率正好等于门槛 → 绿（门槛是下限，不是上限）',
    summarize(samplesFrom('a:1:a:1:a:1:a:0:a:0'), { threshold: 0.6 }).ok === true, '3/5 vs 门槛 0.6');
  check('【关键】任务顺序按首次出现排（报告的表格不能每次乱序）',
    summarize(samplesFrom('z:1:a:1:m:1')).byTask.map((t) => t.id).join(',') === 'z,a,m',
    summarize(samplesFrom('z:1:a:1:m:1')).byTask.map((t) => t.id).join(','));
  check('重跑次数按「样本数 / 任务数」算出来，不靠调用方声明',
    summarize(samplesFrom('a:1:a:1:b:1:b:1')).totals.repeats === 2, '2 任务 4 样本');
  check('没有样本时不除零', summarize([]).totals.rate === 0 && summarize([]).ok === false, JSON.stringify(summarize([]).totals));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 任务定义校验：错的定义要在花钱之前被挡住
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n4. 任务定义校验（负例必须真的被判出来）');

{
  const bad = [
    { id: 'typo', prompt: 'x', check: { type: 'fileContain' } },
    { id: 'dup', prompt: 'x', check: { type: 'replyContains', expect: 'a' } },
    { id: 'dup', prompt: 'x', check: { type: 'replyContains', expect: 'b' } },
    { id: 'long-horizon-short', turns: ['a', 'b'], check: { type: 'replyContains', expect: 'x' } },
    { id: 'no-check', prompt: 'x' },
  ];
  const problems = validateTasks(bad, { knownChecks: AGENT_CHECKS });
  const joined = problems.join('\n');
  check('判据类型写错 → 报出来（一个字母的错误不该花一次 API 调用去发现）', /未知判据类型 fileContain/.test(joined), joined);
  check('id 重复 → 报出来', /id 重复/.test(joined), joined);
  check('长程任务轮数不够 → 报出来', /长程任务，但只有 2 轮/.test(joined), joined);
  check('没有判据 → 报出来', /没有判据/.test(joined), joined);
  check('一次报出所有问题，而不是修一个跑一次', problems.length >= 4, String(problems.length));

  const fixtureObj = validateTasks([{ id: 'f', prompt: 'x', fixtures: { a: { b: 1 } }, check: { type: 'fileAbsent', path: 'a' } }], {});
  check('夹具不是字符串 → 报出来（否则会被静默写成 [object Object]）', /夹具 a 不是字符串/.test(fixtureObj.join('\n')), fixtureObj.join('\n'));

  const emptyTurns = validateTasks([{ id: 'e', turns: [], check: { type: 'fileAbsent', path: 'a' } }], {});
  check('turns 是空数组 → 报出来', /turns 是空数组/.test(emptyTurns.join('\n')), emptyTurns.join('\n'));

  const emptyAll = validateTasks([{ id: 'e', prompt: 'x', check: { all: [] } }], {});
  check('all 是空数组 → 报出来（等于没有判据）', /all 是空数组/.test(emptyAll.join('\n')), emptyAll.join('\n'));

  const badGrowth = validateTasks([{ id: 'g', prompt: 'x', check: { type: 'turnPromptGrowth' } }], { knownChecks: AGENT_CHECKS });
  check('turnPromptGrowth 没给 max → 报出来', /需要正数 max/.test(badGrowth.join('\n')), badGrowth.join('\n'));

  /*
   * The two tool-call checks, and the boundary that makes them worth having.
   *
   * `max: 0` is the whole point of `toolCallsAtMost` ("a greeting calls no tool"), and it is exactly
   * the value a truth-check validator would eat: `!Number(0)` is true. Tested as a positive case so a
   * future refactor back to a truth check fails here rather than in a paying run.
   */
  const noMax = validateTasks([{ id: 't', prompt: 'x', check: { type: 'toolCallsAtMost' } }], { knownChecks: AGENT_CHECKS });
  check('toolCallsAtMost 没给 max → 报出来', /需要 0 或正整数 max/.test(noMax.join('\n')), noMax.join('\n'));
  const zeroMax = validateTasks([{ id: 't', prompt: 'x', check: { type: 'toolCallsAtMost', max: 0 } }], { knownChecks: AGENT_CHECKS });
  check('【关键】toolCallsAtMost 的 max: 0 是合法的（"一次工具都不许调用"）', zeroMax.length === 0, zeroMax.join('\n'));
  const badMax = validateTasks([{ id: 't', prompt: 'x', check: { type: 'toolCallsAtMost', max: -1 } }], { knownChecks: AGENT_CHECKS });
  check('toolCallsAtMost 的 max 是负数 → 报出来', /需要 0 或正整数 max/.test(badMax.join('\n')), badMax.join('\n'));
  const noTool = validateTasks([{ id: 't', prompt: 'x', check: { type: 'toolCallsInclude' } }], { knownChecks: AGENT_CHECKS });
  check('toolCallsInclude 没给 tool → 报出来', /需要非空 tool/.test(noTool.join('\n')), noTool.join('\n'));

  /*
   * `toolCallsExclude` — the "must NOT have run" half. Validated for the same reason as the
   * include half: `tools: []` would exclude nothing while reading as if it excluded everything.
   */
  const noTools = validateTasks([{ id: 't', prompt: 'x', check: { type: 'toolCallsExclude' } }], { knownChecks: AGENT_CHECKS });
  check('toolCallsExclude 没给 tools → 报出来', /需要非空 tools 数组/.test(noTools.join('\n')), noTools.join('\n'));
  const emptyTools = validateTasks([{ id: 't', prompt: 'x', check: { type: 'toolCallsExclude', tools: [] } }], { knownChecks: AGENT_CHECKS });
  check('【关键】toolCallsExclude 的 tools: [] 不合法（空列表等于什么都没排除）',
    /需要非空 tools 数组/.test(emptyTools.join('\n')), emptyTools.join('\n'));
  const blankTool = validateTasks([{ id: 't', prompt: 'x', check: { type: 'toolCallsExclude', tools: [' '] } }], { knownChecks: AGENT_CHECKS });
  check('toolCallsExclude 的 tools 里有空项 → 报出来', /有空项/.test(blankTool.join('\n')), blankTool.join('\n'));
  const okExclude = validateTasks([{ id: 't', prompt: 'x', check: { type: 'toolCallsExclude', tools: ['shell'] } }], { knownChecks: AGENT_CHECKS });
  check('toolCallsExclude 的正例不报问题', okExclude.length === 0, okExclude.join('\n'));

  /*
   * `kb` — seeded memories. A task that asks about a fact nobody can see only means something if the
   * fact is really seeded, so the shape is validated before an API call is spent on it.
   */
  const kbNotArray = validateTasks([{ id: 'k', prompt: 'x', kb: { groupName: 'g' }, check: { type: 'fileAbsent', path: 'a' } }], {});
  check('kb 不是数组 → 报出来', /kb 不是数组/.test(kbNotArray.join('\n')), kbNotArray.join('\n'));
  const kbMissing = validateTasks([{ id: 'k', prompt: 'x', kb: [{ groupName: 'g', title: 't' }], check: { type: 'fileAbsent', path: 'a' } }], {});
  check('kb 条目缺 content → 报出来（否则种进去的是条空记忆，任务看着却是对的）',
    /kb\[0\] 的 content 缺失或为空/.test(kbMissing.join('\n')), kbMissing.join('\n'));
  const kbBlank = validateTasks([{ id: 'k', prompt: 'x', kb: [{ groupName: 'g', title: ' ', content: 'c' }], check: { type: 'fileAbsent', path: 'a' } }], {});
  check('kb 条目里有空字符串 → 报出来', /kb\[0\] 的 title 缺失或为空/.test(kbBlank.join('\n')), kbBlank.join('\n'));
  const kbOk = validateTasks([{ id: 'k', prompt: 'x', kb: [{ groupName: 'g', title: 't', content: 'c' }], check: { type: 'fileAbsent', path: 'a' } }], {});
  check('kb 的正例不报问题（没有 kb 字段的任务照旧合法）', kbOk.length === 0, kbOk.join('\n'));

  const good = validateTasks([{ id: 'long-horizon-x', turns: ['a', 'b', 'c', 'd'], check: { type: 'fileContains', path: 'p', expect: ['x'] } }], { knownChecks: AGENT_CHECKS });
  check('正例不报问题（校验器不能什么都拦）', good.length === 0, good.join('\n'));

  const verifyOnly = validateTasks([{ id: 'v', prompt: 'x', check: { type: 'replyLacks', unexpected: 'y' } }], { knownChecks: VERIFY_CHECKS });
  check('verification 的判据集合自成一套（replyLacks 在那边合法）', verifyOnly.length === 0, verifyOnly.join('\n'));
  const crossOver = validateTasks([{ id: 'v', prompt: 'x', check: { type: 'replyLacks', unexpected: 'y' } }], { knownChecks: AGENT_CHECKS });
  check('同一份定义换到另一套判据里会被判错（两边不是同一个集合）', crossOver.length === 1, crossOver.join('\n'));

  check('checksOf 处理单个判据与 all 列表', checksOf({ check: { type: 'a' } }).length === 1
    && checksOf({ check: { all: [{ type: 'a' }, { type: 'b' }] } }).length === 2
    && checksOf({}).length === 0, 'checksOf');
  check('turnCount 区分单轮与多轮', turnCount({ prompt: 'x' }) === 1 && turnCount({ turns: ['a', 'b', 'c'] }) === 3, 'turnCount');

  const dir = mkdtempSync(join(tmpdir(), 'she-eval-tasks-'));
  try {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ "tasks": [ }', 'utf8');
    let msg = '';
    try { loadTasks(broken); } catch (err) { msg = err.message; }
    check('任务文件 JSON 坏了 → 报错里带文件名', /不是合法 JSON/.test(msg) && msg.includes('broken.json'), msg);

    const notasks = join(dir, 'notasks.json');
    writeFileSync(notasks, '{"nope": 1}', 'utf8');
    let msg2 = '';
    try { loadTasks(notasks); } catch (err) { msg2 = err.message; }
    check('任务文件里没有 tasks 数组 → 说清楚', /没有 tasks 数组/.test(msg2), msg2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 真实的两个任务文件：现在就得是自洽的
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n5. 仓库里的真实任务');

{
  check('evals/agent/tasks.json 存在', existsSync(AGENT_TASKS), AGENT_TASKS);
  check('evals/verification/tasks.json 存在', existsSync(VERIFY_TASKS), VERIFY_TASKS);

  const agentTasks = loadTasks(AGENT_TASKS);
  const agentProblems = validateTasks(agentTasks, { knownChecks: AGENT_CHECKS });
  check(`agent 任务全部自洽（${agentTasks.length} 个）`, agentProblems.length === 0, agentProblems.join('\n'));

  const verifyTasks = loadTasks(VERIFY_TASKS);
  const verifyProblems = validateTasks(verifyTasks, { knownChecks: VERIFY_CHECKS });
  check(`verification 任务全部自洽（${verifyTasks.length} 个）`, verifyProblems.length === 0, verifyProblems.join('\n'));

  const longHorizon = agentTasks.filter((t) => /^long-horizon/.test(t.id));
  check('【关键】有一套长程任务（多轮对话，不是多步任务）', longHorizon.length >= 2, String(longHorizon.length));
  const longest = Math.max(0, ...longHorizon.map(turnCount));
  check('【关键】至少有一个 5 轮以上的任务（2 轮只能测交接，测不出长程）', longest >= 5, String(longest));
  check('长程任务里有上下文膨胀判据（长程真正的死法）',
    longHorizon.some((t) => checksOf(t).some((c) => c.type === 'turnPromptGrowth')),
    longHorizon.map((t) => t.id).join(','));
  check('每个任务都有 note（否则失败时不知道它在测什么）',
    agentTasks.every((t) => typeof t.note === 'string' && t.note.length > 0),
    agentTasks.filter((t) => !t.note).map((t) => t.id).join(','));

  /*
   * The two tasks that grade a METHOD, pinned by name.
   *
   * Both were passing for the wrong reason: the greeting graded a token count (a proxy for "no tool
   * ran"), and the delegation task graded only the answer file — so the parent could do the reading
   * itself and the task would still go green. A task named after a path has to assert the path, or
   * the name is the only place the intent exists.
   */
  const greeting = agentTasks.find((t) => t.id === 'greeting-cheap');
  check('【关键】问候语任务断言「一次工具都不调」，而不是只看用量这个代理指标',
    checksOf(greeting).some((c) => c.type === 'toolCallsAtMost' && c.max === 0),
    JSON.stringify(checksOf(greeting)));
  const delegation = agentTasks.find((t) => t.id === 'subagent-delegation');
  check('【关键】委派任务断言真的调用了 task_spawn（否则自己读文件也算通过）',
    checksOf(delegation).some((c) => c.type === 'toolCallsInclude' && c.tool === 'task_spawn'),
    JSON.stringify(checksOf(delegation)));
  check('委派任务仍然断言交付内容正确（不只看路径）',
    checksOf(delegation).some((c) => c.type === 'fileContains'),
    JSON.stringify(checksOf(delegation)));

  /*
   * The KB tasks, pinned by name for the same reason as the two above.
   *
   * Both of their claims are about the METHOD — did it query, did it avoid the raw file — and
   * without these assertions the tasks could be edited into something that still passes while
   * measuring nothing (the seeding could be dropped, or the exclusion list emptied).
   */
  const proactive = agentTasks.find((t) => t.id === 'kb-proactive-recall');
  check('【关键】主动检索任务真的有种子记忆（答案不在工作区文件里，否则查不查都能答对）',
    Array.isArray(proactive?.kb) && proactive.kb.length > 0, JSON.stringify(proactive?.kb));
  check('【关键】主动检索任务断言真的调用了 kb_query（否则「不主动检索」这个故障抓不到）',
    checksOf(proactive).some((c) => c.type === 'toolCallsInclude' && c.tool === 'kb_query'),
    JSON.stringify(checksOf(proactive)));
  check('主动检索任务同时断言答对了（调了但没用上等于白调）',
    checksOf(proactive).some((c) => c.type === 'replyContains'),
    JSON.stringify(checksOf(proactive)));

  const noRaw = agentTasks.find((t) => t.id === 'kb-no-raw-sqlite');
  check('【关键】禁止直查库的任务把 shell / fs_read / fs_write 都排除了',
    checksOf(noRaw).some((c) => c.type === 'toolCallsExclude'
      && ['shell', 'fs_read', 'fs_write'].every((n) => c.tools.includes(n))),
    JSON.stringify(checksOf(noRaw)));
  check('禁止直查库的任务也断言了真的经 kb_query 拿到答案',
    checksOf(noRaw).some((c) => c.type === 'toolCallsInclude' && c.tool === 'kb_query'),
    JSON.stringify(checksOf(noRaw)));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 接线：--dry-run 真的离线，--repeat 真的被认
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n6. 接线：dry run 不联网，repeat 被认');

{
  /*
   * Run with an unusable endpoint and no key. If dry run touched the API it would fail here, and
   * that is the property worth pinning: "check the tasks" must be safe to run anywhere, including
   * CI and a machine that has never been configured.
   */
  const offlineEnv = hermeticEnv({
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OPENAI_BASE_URL: 'http://127.0.0.1:1',
    SHE_LLM_FALLBACK_BASE_URL: '',
    SHE_LLM_FALLBACK_MODEL: '',
  });

  for (const [label, script] of [
    ['agent', join(ROOT, 'evals', 'agent', 'run.mjs')],
    ['verification', join(ROOT, 'evals', 'verification', 'run.mjs')],
  ]) {
    const r = spawnSync(process.execPath, [script, '--dry-run'], {
      cwd: ROOT, encoding: 'utf8', env: offlineEnv, timeout: 60_000, windowsHide: true,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    check(`${label}: --dry-run 在没有 key / 不可达端点下也能跑通（证明它没联网）`,
      r.status === 0, `status=${r.status} ${out.slice(-300)}`);
    check(`${label}: --dry-run 明确说了不调用 API`, /不调用任何 API/.test(out), out.slice(0, 200));
  }

  const agentDry = spawnSync(process.execPath, [join(ROOT, 'evals', 'agent', 'run.mjs'), '--dry-run'], {
    cwd: ROOT, encoding: 'utf8', env: offlineEnv, timeout: 60_000, windowsHide: true,
  }).stdout ?? '';
  check('【关键】--dry-run 列出了长程任务（接线上的证据，不只是函数存在）',
    /long-horizon-[a-z-]+\s+\d+ 轮/.test(agentDry), agentDry.slice(0, 400));

  /*
   * `--repeat` is a CLI contract: a typo in the flag or the parse would silently fall back to 1, and
   * the run would look perfectly fine while producing a single sample — exactly the thing the flag
   * exists to fix. Checked through the header line, which prints the count it settled on.
   */
  const dryWith = (extra) => spawnSync(
    process.execPath,
    [join(ROOT, 'evals', 'agent', 'run.mjs'), '--dry-run', ...extra],
    { cwd: ROOT, encoding: 'utf8', env: offlineEnv, timeout: 60_000, windowsHide: true },
  ).stdout ?? '';

  check('--repeat 3 被认（回执里写着 3）', /重跑次数 3/.test(dryWith(['--repeat', '3'])), dryWith(['--repeat', '3']).slice(-200));
  check('--repeat 0 被夹到 1（否则会变成「一次都不跑」）', /重跑次数 1/.test(dryWith(['--repeat', '0'])), 'repeat 0 → 1');
  check('--repeat 乱填也被夹到 1', /重跑次数 1/.test(dryWith(['--repeat', 'abc'])), 'repeat abc → 1');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. README 与真实任务/真实读数一致
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n7. README 不许与 tasks.json 漂移');

{
  /*
   * `evals/README.md` 是这两套评测唯一对外的话。它漂过两次，而且两次都漂在「凭记忆写」的地方：
   *
   *   - 检索那一行写着 `hybrid 100% vs BM25 73%`，而 `node evals/retrieval/run.mjs` 当时印的是
   *     80% / 67%（一次没人复跑过的引用）；
   *   - 「已知局限」里写着「没有长程任务评测（>10 轮的）」，而 tasks.json 里躺着三个
   *     `long-horizon-*`。
   *
   * 两处都不是笔误，是「文档说了一件代码里不成立的事」，而这正是这套检查存在的理由。所以这里
   * 钉两条能从代码机械推出来的：任务表列全、以及「有没有长程任务」这句话不许和 tasks.json 相反。
   */
  const readmePath = join(ROOT, 'evals', 'README.md');
  const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : '';
  check('evals/README.md 存在', readme.length > 0, readmePath);
  check('README 引用了检索评测的真实入口（数字要能被人复跑）',
    readme.includes('node evals/retrieval/run.mjs'), readme.slice(0, 200));

  const agentIds = loadTasks(AGENT_TASKS).map((t) => t.id);
  const verifyIds = loadTasks(VERIFY_TASKS).map((t) => t.id);
  const missing = [...agentIds, ...verifyIds].filter((id) => !readme.includes(id));
  check(`【关键】15 个 agent 任务每个都在 README 的任务表里（缺: ${missing.length}）`,
    missing.length === 0, `没写进 README 的: ${missing.join(', ')}`);

  const longIds = agentIds.filter((id) => id.startsWith('long-horizon-'));
  /*
   * 「长程」这句话两侧都要判：有任务时不许说没有（README 漂过的那次），没任务时也不许说有
   * （否则删掉任务后这句话会变成新的假话）。
   */
  const claimsNoLongHorizon = /没有\*{0,2}长程任务/.test(readme);
  check(`【关键】「有没有长程任务」这句话与 tasks.json 一致（有 ${longIds.length} 个 long-horizon-*）`,
    longIds.length > 0 ? !claimsNoLongHorizon : claimsNoLongHorizon,
    claimsNoLongHorizon ? 'README 说没有长程任务，但 tasks.json 里有' : 'README 没说，但也没有长程任务');
  check('长程任务在 README 里被点名（不是只写了个数字）',
    longIds.every((id) => readme.includes(id)), longIds.join(', '));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 每轮都要付的固定开销：离线量得到，所以离线钉住
 * ══════════════════════════════════════════════════════════════════════════ */

console.log('\n8. 固定开销（系统提示词 + 工具表）不许无声长大');

{
  /*
   * 「问候语」那条任务第五轮实测红过一次：prompt 14087 > 上限 13000。查下去的真正结论不是成本
   * 回归，而是**基线自己长大了**（提示词 + 工具表从 ~35.7k 字符长到 48.9k 字符，几轮下来每轮加
   * 一点：方言说明、姿态提示、等待出口、预检段……），而那条上限是照着当年的数字写死的。
   *
   * 两件事一起做才算修好：
   *   - 那条任务改成跟自己比（`promptWithinOverhead`，见 evals/agent/run.mjs），它不会过期；
   *   - 长大这件事本身要有地方看得见，而且**不必花钱**。固定开销是纯文本，离线就能量：
   *     这里量一次，超预算就红，红了就在这一处做决定（删文本，或者明确改这个数）。
   *
   * 只量不判红是不够的：一条只会打印数字的检查没人看，而这条曲线的全部意义就是有人看。
   */
  const budget = 55_000;

  /*
   * 接线与 `evals/agent/run.mjs` 一致（同一批工具、同样 automationMode、同样没有会话号），
   * 否则这里量到的不是那条任务真正付的钱。
   */
  let overhead = null;
  let why = '';
  try {
    const { loadConfig } = await import('../packages/shared/dist/index.js');
    const { KBStore, GroupKBEngine } = await import('../packages/kb/dist/index.js');
    const { SandboxShell, createTools } = await import('../packages/sandbox/dist/index.js');
    const { Agent } = await import('../packages/agent-runtime/dist/index.js');

    const dir = mkdtempSync(join(tmpdir(), 'she-evals-overhead-'));
    const cfg = loadConfig(ROOT);
    cfg.workspace.root = dir;
    cfg.automationMode = true;
    cfg.sandbox.allowAllCommands = true;
    mkdirSync(join(dir, '.she'), { recursive: true });
    const store = new KBStore(join(dir, '.she', 'kb.sqlite'));
    const engine = new GroupKBEngine(store, { ...cfg.kb, dbPath: join(dir, '.she', 'kb.sqlite') });
    const tools = createTools(new SandboxShell(dir, cfg.sandbox), dir, {
      allowAllCommands: true,
      kbDbPath: join(dir, '.she', 'kb.sqlite'),
    });
    const agent = new Agent(cfg, engine, tools, null, { subagentRunner: { run: async () => ({}) } });
    const promptChars = agent.getSystemPromptText().length;
    const defs = agent.getToolDefinitions();
    const toolChars = JSON.stringify(defs).length;
    const biggest = defs
      .map((d) => ({ name: d.name, chars: JSON.stringify(d).length }))
      .sort((a, b) => b.chars - a.chars)[0];
    overhead = { promptChars, toolChars, total: promptChars + toolChars, tools: defs.length, biggest };
    await agent.dispose?.();
    store.close();
    removeTempDir(dir);
  } catch (err) {
    why = err.message;
  }

  check('能量到固定开销（提示词 + 工具表，不需要 API）', overhead !== null, why);
  if (overhead) {
    console.log(`        系统提示词 ${overhead.promptChars} 字符 + ${overhead.tools} 个工具 ${overhead.toolChars} 字符`
      + ` = ${overhead.total} 字符（最肥的：${overhead.biggest.name} ${overhead.biggest.chars} 字符）`);
    check(`【关键】固定开销在预算内（${overhead.total} ≤ ${budget} 字符，约 ${Math.round(overhead.total / 3.47)} prompt tokens）`,
      overhead.total <= budget,
      `超了 ${overhead.total - budget} 字符。每轮都要付这份钱，所以长大必须是有意的：`
      + `要么删文本，要么在这个文件里明确抬高 budget（并在 evals/README.md 记下为什么）。`);
  }

  /*
   * 那条任务不许再退回写死的绝对值：写死的数会在下一次提示词长大时静默过期（它已经过期过一次）。
   * 判据本身也要有：`promptWithinOverhead` 必须真的在 runner 里实现，而不是只写在 JSON 里。
   */
  const greetingTask = loadTasks(AGENT_TASKS).find((t) => t.id === 'greeting-cheap');
  check('【关键】问候语任务与自己比（promptWithinOverhead），而不是写死的 token 上限',
    checksOf(greetingTask).some((c) => c.type === 'promptWithinOverhead'),
    JSON.stringify(checksOf(greetingTask)));
  check('不再留着过期的 usageBelow 绝对上限',
    !checksOf(greetingTask).some((c) => c.type === 'usageBelow'),
    JSON.stringify(checksOf(greetingTask)));
  const runner = readFileSync(join(ROOT, 'evals', 'agent', 'run.mjs'), 'utf8');
  check('runner 真的实现了这条判据（不是只写在任务 JSON 里）',
    /if \(check\.type === 'promptWithinOverhead'\)/.test(runner));
  check('换算系数由实测写成常量，且写了怎么重测',
    /const CHARS_PER_TOKEN = [\d.]+;/.test(runner) && /重测/.test(runner));
  check('取不到固定开销时判红，不判绿（静默通过的判据比没有判据更坏）',
    /取不到固定开销[\s\S]{0,80}无法判断/.test(runner));
  const readme = readFileSync(join(ROOT, 'evals', 'README.md'), 'utf8');
  check('README 记着这个换算的实测值与日期（换模型的人知道去哪看）',
    /字符\/token/.test(readme) && /3\.47/.test(readme));
}

console.log('');
if (failures) {
  console.log(`${failures} 项失败`);
  process.exit(1);
}
console.log('评测框架检查通过');
