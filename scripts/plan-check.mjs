/**
 * Plans as a graph — offline, no API calls, no ports.
 *
 * The plan file is the only thing that survives a restart, so a wrong plan is worse than no
 * plan: it is read back later as "what I was doing" and believed. Two failures are invisible
 * from the outside and both used to be possible:
 *
 *   - the marks say `2/2 完成` while a prerequisite was never done, because a step could be
 *     marked done out of order;
 *   - a plan parks forever with no indication of which step is in the way, or the plan said
 *     `skip` and the steps downstream of the skip wait for input that never comes.
 *
 * So this check does not re-assert the store's rules. It drives the real `plan_*` tools the way
 * the agent does, throws the toolset away to simulate a restart, and reads the plan back:
 *
 *   1. A dependency graph created through `plan_create` schedules the right step.
 *   2. Out-of-order updates are refused, and the refusal is classifiable.
 *   3. Resume: a NEW toolset names the correct next step, and another conversation in the SAME
 *      workspace continues the same plan.
 *   4. Failure policies: skip cascades, stop parks, retry counts, ask defers.
 *   5. The completion count never overstates what happened.
 *   6. The boundary itself: one plan per workspace, provenance recorded, another workspace blind.
 *
 * ## Why each section gets its own temp workspace
 *
 * 2026-10-01 起计划是**工作区级**的（`.she/plans.json`）：一个项目里所有会话读写同一份。这个检查里的
 * "会话"（sess-a / sess-b …）因此**不再隔离**任何东西 —— 它们只是来源标记。如果整份检查共用一个
 * 临时目录，第 3 节建的计划会留在盘上，第 5 节的 `plan_update`（不带 plan_id 时解析到"最近动过的
 * 那份")就可能落到它上面。那不是被测代码的问题，是这份检查假设了已经不存在的隔离。
 *
 * 所以每节用一个新的工作区目录：节与节之间看不见，正是模型本身要的性质。
 */
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createPlanTools,
  classifyToolResult,
  getSystemPrompt,
  planSessions,
  PlanStore,
  adoptSessionPlansIntoWorkspace,
  WORKSPACE_SCOPE,
} from '../packages/agent-runtime/dist/index.js';
import { removeTempDir } from './lib/temp.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
void PROJECT_ROOT;

const workspaces = [];
/** 一个新的工作区目录 —— 一节一个，节与节之间互相看不见。 */
function makeWorkspace() {
  const d = mkdtempSync(join(tmpdir(), 'she-plan-'));
  mkdirSync(join(d, '.she'), { recursive: true });
  workspaces.push(d);
  return d;
}

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 600)}`);
  }
};

/**
 * Tools bound to one conversation. `session` is now only a provenance stamp — every call in
 * `dir` reads and writes the same `.she/plans.json`. A second call stands in for a restart.
 */
const toolsFor = (dir, session) => createPlanTools(dir, session);

const call = async (tools, name, args) => tools.execute(name, args);

/**
 * The plan as stored on disk — not the object the tool just returned.
 *
 * 工作区级：只有一份 `.she/plans.json`。读错位置会让这一段"验证落盘"变成验证空气，所以路径写死。
 */
const onDisk = (dir) => JSON.parse(readFileSync(join(dir, '.she', 'plans.json'), 'utf8'));

const mark = (planText, stepId) =>
  planText.split('\n').find((l) => new RegExp(`\\s${stepId}\\s`).test(l))?.trim() ?? '';

console.log('1. 依赖图：该开始的是「前置都做完」的那一步');
{
  const dir = makeWorkspace();
  const tools = toolsFor(dir, 'sess-a');
  const created = await call(tools, 'plan_create', {
    title: '发版',
    goal: '把 2.0 发出去',
    steps: [
      '跑测试',
      { title: '构建产物', dependsOn: ['s1'] },
      { title: '写发布说明', onFailure: 'skip' },
      { title: '打 tag', dependsOn: ['s2', 's3'] },
    ],
  });
  check('创建计划时给出「下一步」', /下一步: s1 跑测试/.test(created), created);
  check('打印出依赖，否则不知道为什么还不能开始', /依赖: s1/.test(created), created);
  check('非默认的失败策略也打印', /失败策略: skip/.test(created), created);
  check('没有依赖的步骤能直接开始', mark(created, 's1').includes('[>]'), created);
  check('依赖没满足的步骤不动', mark(created, 's2').includes('[ ]'), created);

  const refused = await call(tools, 'plan_update', { step_id: 's2', status: 'done' });
  check('越序标完成被拒绝', refused.startsWith('Error: '), refused);
  check('拒绝时说清是哪一步挡着', /s1/.test(refused), refused);
  check(
    '拒绝可被分类为 precondition（不是说不清的 unknown）',
    classifyToolResult('plan_update', refused).kind === 'precondition',
    classifyToolResult('plan_update', refused).kind,
  );
  const afterRefusal = onDisk(dir)[0];
  check(
    '被拒绝后盘上的状态没变（没有「标了但没记」）',
    afterRefusal.steps[1].status === 'pending' && afterRefusal.steps[0].status === 'active',
    JSON.stringify(afterRefusal.steps.map((s) => `${s.id}:${s.status}`)),
  );

  await call(tools, 'plan_update', { step_id: 's1', status: 'done' });
  let now = await call(tools, 'plan_list', {});
  check('前置完成后轮到 s2', /下一步: s2 构建产物/.test(now), now);

  await call(tools, 'plan_update', { step_id: 's2', status: 'done' });
  now = await call(tools, 'plan_list', {});
  check(
    's4 要等 s2 和 s3 都完成，不能只看一个',
    /下一步: s3 写发布说明/.test(now),
    now,
  );

  await call(tools, 'plan_update', { step_id: 's3', status: 'done' });
  now = await call(tools, 'plan_list', {});
  check('两个前置都完成后才轮到 s4', /下一步: s4 打 tag/.test(now), now);

  const done = await call(tools, 'plan_update', { step_id: 's4', status: 'done' });
  check('全部做完后收口，不再给「下一步」', /下一步: 无，计划已收口/.test(done), done);
  // plan_update now replies with only the changed step; the whole plan is read back via plan_list.
  const doneFull = await call(tools, 'plan_list', {});
  check('完成数不会超过实际做完的步数', /4\/4 完成/.test(doneFull), doneFull);
}

console.log('\n2. 断点恢复：换一个 store 还知道从哪继续；同工作区的另一条会话也能接着做');
{
  const dir = makeWorkspace();
  const tools = toolsFor(dir, 'sess-b');
  await call(tools, 'plan_create', {
    title: '迁移数据库',
    steps: ['备份', { title: '跑迁移', dependsOn: ['s1'] }, { title: '验证', dependsOn: ['s2'] }],
  });
  await call(tools, 'plan_update', { step_id: 's1', status: 'done' });

  // Everything in memory is gone: a new toolset over the same workspace stands in for a restart.
  const restarted = toolsFor(dir, 'sess-b');
  const listed = await call(restarted, 'plan_list', {});
  check('重启后仍看得见计划', /迁移数据库/.test(listed), listed);
  check('重启后直接指出从哪一步继续', /下一步: s2 跑迁移/.test(listed), listed);
  check('已完成的那一步仍标着完成', mark(listed, 's1').includes('[x]'), listed);
  check('进度数也对得上', /1\/3 完成/.test(listed), listed);

  /*
   * The restart case that matters is a step that was `active` when the process died. It has to
   * come back as `active` — not as `pending` (which reads as "never started" and loses the fact
   * that half the work may be on disk) and not as `done`.
   */
  const raw = onDisk(dir).find((p) => p.title === '迁移数据库');
  check('盘上记的是步骤状态，不是渲染出来的文本', raw.steps[1].status === 'active', JSON.stringify(raw.steps));

  const next = await call(restarted, 'plan_update', { step_id: 's2', status: 'done' });
  check('恢复后能接着正常推进', /下一步: s3 验证/.test(next), next);

  /*
   * 【关键】同一个工作区的另一条会话**看得见**这份计划，也**能接着做**。
   *
   * 这一条的方向和 2026-09-27 那版是相反的，所以值得写清楚为什么：边界划在"对话之间"不是用户脑子
   * 里的边界。用户在一个项目里新开一个对话，期待的是昨天那个长任务还在；把它藏起来才是意外。改回
   * "按会话隔离"会让这一条变红 —— 这是有意的，不是失手。
   */
  const other = toolsFor(dir, 'sess-c');
  const otherListed = await call(other, 'plan_list', {});
  check('【关键】同工作区的另一条会话看得见这份计划', /迁移数据库/.test(otherListed), otherListed);
  const otherEdit = await call(other, 'plan_update', { plan_id: raw.id, step_id: 's3', status: 'done' });
  check('【关键】并且能接着往里推进度', !otherEdit.startsWith('Error: '), otherEdit);
  check('推进度真的写进了同一份文件', onDisk(dir).find((p) => p.id === raw.id).steps[2].status === 'done');

  // 来源被记下来了：用户看到一份计划时要能分辨它是哪次对话留下的。
  check(
    '计划带着创建它的会话 id（来源，不是所有权）',
    raw.sessionId === 'sess-b',
    JSON.stringify({ sessionId: raw.sessionId }),
  );
}

console.log('\n3. 工作区就是边界：换一个工作区什么都看不见');
{
  const dir = makeWorkspace();
  const otherRoot = makeWorkspace();
  await call(toolsFor(dir, 'sess-a'), 'plan_create', { title: '这个项目的活', steps: ['x'] });

  check('本工作区看得到', /这个项目的活/.test(await call(toolsFor(dir, 'sess-z'), 'plan_list', {})), null);
  const blind = await call(toolsFor(otherRoot, 'sess-z'), 'plan_list', {});
  check('【关键】另一个工作区看不到', !/这个项目的活/.test(blind), blind);
  check(
    '【关键】隔离靠路径而不是过滤：另一个工作区连文件都没有',
    !existsSync(join(otherRoot, '.she', 'plans.json')),
    null,
  );
}

console.log('\n4. 失败策略：写下来的处置办法要真的执行');
{
  const dir = makeWorkspace();
  const tools = toolsFor(dir, 'sess-d');
  const created = await call(tools, 'plan_create', {
    title: '装依赖',
    steps: [
      { title: '装 libfoo', onFailure: 'skip' },
      { title: '编译', dependsOn: ['s1'] },
      { title: '打包', dependsOn: ['s2'] },
    ],
  });
  check('创建时就存下策略', /失败策略: skip/.test(created), created);

  const skipped = await call(tools, 'plan_update', { step_id: 's1', status: 'blocked', note: '没网' });
  check('skip 让这一步变成 skipped', mark(skipped, 's1').includes('[-]'), skipped);
  check('依赖它的步骤一起被跳过', mark(skipped, 's2').includes('[-]'), skipped);
  check('被牵连的步骤写清是谁害的', /s1 被跳过/.test(mark(skipped, 's2')), skipped);
  check('传递依赖也一起跳过', mark(skipped, 's3').includes('[-]'), skipped);
  check('剩下的都结束了，计划收口而不是永远 open', /状态 done/.test(skipped), skipped);
  check('没有任何一步被写成 done 来收口', !mark(skipped, 's1').includes('[x]'), skipped);
}

{
  const dir = makeWorkspace();
  const tools = toolsFor(dir, 'sess-e');
  await call(tools, 'plan_create', { title: '停', steps: [{ title: 'a' }, { title: 'b', dependsOn: ['s1'] }] });
  const blocked = await call(tools, 'plan_update', { step_id: 's1', status: 'blocked', note: '装不上' });
  check('stop 策略下这一步停在 blocked', mark(blocked, 's1').includes('[!]'), blocked);
  const blockedFull = await call(tools, 'plan_list', {});
  check('受阻的计划不当作完成', /状态 open/.test(blockedFull), blockedFull);
  check('受阻时下一步就是那一步，不能消失', /下一步: s1 a/.test(blocked), blocked);
  check('并说清要用户决定', /onFailure=stop/.test(blocked) && /需要用户决定/.test(blocked), blocked);
  check('后面那步不能因为前面受阻就偷偷开始', mark(blockedFull, 's2').includes('[ ]'), blockedFull);
}

{
  const dir = makeWorkspace();
  const tools = toolsFor(dir, 'sess-f');
  await call(tools, 'plan_create', { title: '重试', steps: [{ title: '拉取', onFailure: 'retry' }] });
  const first = await call(tools, 'plan_update', { step_id: 's1', status: 'blocked', note: '超时' });
  check('retry 明确说「换个做法再试一次」，不是含糊的失败', /换个做法再试一次/.test(first), first);
  check('记下这是第 1 次', /已试 1 次/.test(first), first);

  const second = await call(tools, 'plan_update', { step_id: 's1', status: 'blocked', note: '还是超时' });
  check('第二次失败看得见，不是静默死循环', /已试 2 次/.test(second), second);
  check('「下一步」里也报出次数', /已试过 2 次/.test(second), second);
}

{
  const dir = makeWorkspace();
  const tools = toolsFor(dir, 'sess-g');
  await call(tools, 'plan_create', { title: '问', steps: [{ title: '删表', onFailure: 'ask' }] });
  const asked = await call(tools, 'plan_update', { step_id: 's1', status: 'blocked', note: '要不要删' });
  check('ask 策略指明该调用 ask_user', /ask_user/.test(asked), asked);
}

console.log('\n5. 图的形状本身不能被写坏');
{
  const dir = makeWorkspace();
  const tools = toolsFor(dir, 'sess-h');
  const created = await call(tools, 'plan_create', { title: '图', steps: ['a', 'b'] });
  check('创建时依赖了不存在的步骤会被丢掉而不是留下死引用', !/依赖: s9/.test(created), created);

  const badDep = await call(tools, 'plan_update', { step_id: 's2', depends_on: ['s9'] });
  check('事后声明一个不存在的依赖会被拒绝', badDep.startsWith('Error: '), badDep);
  const stillClean = onDisk(dir).find((p) => p.title === '图');
  check('拒绝后盘上没有半截依赖', stillClean.steps[1].dependsOn.length === 0, JSON.stringify(stillClean.steps[1]));

  await call(tools, 'plan_update', { step_id: 's1', depends_on: ['s2'] });
  const cycle = await call(tools, 'plan_update', { step_id: 's2', depends_on: ['s1'] });
  check('成环会被拒绝（成环 = 没有任何一步能开始）', /成环/.test(cycle), cycle);
  const afterCycle = onDisk(dir).find((p) => p.title === '图');
  check('成环的依赖不会落盘', afterCycle.steps[1].dependsOn.length === 0, JSON.stringify(afterCycle.steps[1]));

  const reOpened = await call(tools, 'plan_create', { title: '做完又发现活', steps: ['a'] });
  const planId = /plan_[0-9a-f]+/.exec(reOpened)?.[0];
  await call(tools, 'plan_update', { step_id: 's1', status: 'done', plan_id: planId });
  const added = await call(tools, 'plan_add_steps', { plan_id: planId, steps: ['b'] });
  check('给做完的计划加活会重新打开它', /状态 open/.test(added), added);
  check('新加的步骤接着开始', /下一步: s2 b/.test(added), added);
}

console.log('\n6. 提示词里写了怎么用这张图，也写清了边界在哪');
{
  const prompt = getSystemPrompt('dev');
  check('提示词要求按「下一步」续做', /下一步:/.test(prompt) && /Resuming means reading/.test(prompt), null);
  check('提示词要求声明 depends_on', /depends_on/.test(prompt), null);
  check('提示词说明 blocked 不等于完成', /blocked\` is not a step that finished/.test(prompt), null);
  check(
    '【关键】提示词说清计划属于工作区，不是本对话私有',
    /belong to the WORKSPACE/.test(prompt) && /\.she\/plans\.json/.test(prompt),
    null,
  );
  check(
    '【关键】提示词说清"别处留下的未收口计划会拦 done"以及出路',
    /ONE open plan per workspace/.test(prompt) && /report_write/.test(prompt),
    null,
  );
}

console.log('\n7. 清单只列目录作用域（群）；聊天计划本来就在普通视图里');
{
  const dir = makeWorkspace();
  await call(toolsFor(dir, 'sess-a'), 'plan_create', { title: '聊天里的活', steps: ['x'] });
  new PlanStore(dir, 'cluster:r1').create('群里的活', ['y']);

  const summary = planSessions(dir);
  const ids = summary.map((s) => s.session_id);
  /*
   * 聊天计划是工作区级的，不在 `.she/sessions/<id>/` 下面，所以清单**不该**列出 sess-a —— 它本来就
   * 在普通视图里全部可见，不需要"点开哪个会话"这扇门。群计划仍在自己的目录里，所以列得出来。
   */
  check('聊天会话不进清单（它的计划本来就看得到）', !ids.includes('sess-a'), JSON.stringify(summary));
  check('目录作用域（群）列得出来', ids.includes('cluster:r1'), JSON.stringify(summary));
  check('带计数，界面不用为每个作用域再问一次', (summary.find((s) => s.session_id === 'cluster:r1')?.plans ?? 0) === 1, JSON.stringify(summary));
  check('清单里没有任何计划正文', !JSON.stringify(summary).includes('群里的活'), JSON.stringify(summary).slice(0, 200));
}

console.log('\n8. 迁移：2026-09-27 留在会话目录里的计划要收回来');
{
  const dir = makeWorkspace();
  // 那版迁移只搬了"进行中"的那份，已收口的留在了旧的工作区文件里，新会话的计划留在会话目录里。
  const stranded = new PlanStore(dir, 'sess_old').create('会话目录里的活', ['x']);
  new PlanStore(dir, WORKSPACE_SCOPE).create('本来就在工作区里的活', ['y']);

  const first = adoptSessionPlansIntoWorkspace(dir);
  check('收回了 1 份', first.adopted === 1, JSON.stringify(first));
  const titles = new PlanStore(dir, WORKSPACE_SCOPE).list().map((p) => p.title).sort();
  check(
    '两边的计划都在同一份里了（不再有看不见的历史计划）',
    titles.join('|') === ['本来就在工作区里的活', '会话目录里的活'].sort().join('|'),
    JSON.stringify(titles),
  );
  check('按 id 能查到收回来那份', !!new PlanStore(dir, WORKSPACE_SCOPE).get(stranded.id), null);
  check(
    '原文件保留（迁移不是单向门）',
    existsSync(join(dir, '.she', 'sessions', 'sess_old', 'plans.json')),
    null,
  );
  const second = adoptSessionPlansIntoWorkspace(dir);
  check('可重复执行：再跑一次是空操作', second.adopted === 0 && second.updated === 0, JSON.stringify(second));
}

for (const d of workspaces) removeTempDir(d);
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}  plan-check`);
process.exit(failures === 0 ? 0 : 1);
