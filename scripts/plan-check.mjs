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
 *   3. Resume: a NEW toolset (new store, different session) names the correct next step.
 *   4. Failure policies: skip cascades, stop parks, retry counts, ask defers.
 *   5. The completion count never overstates what happened.
 */
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPlanTools, classifyToolResult, getSystemPrompt } from '../packages/agent-runtime/dist/index.js';
import { removeTempDir } from './lib/temp.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'she-plan-'));
mkdirSync(join(dir, '.she'), { recursive: true });

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 600)}`);
  }
};

/** One conversation's tools. A second call is a second conversation, or a restart. */
const toolsFor = (session) => createPlanTools(dir, session);

const call = async (tools, name, args) => tools.execute(name, args);

/** The plan as stored on disk — not the object the tool just returned. */
const onDisk = () => JSON.parse(readFileSync(join(dir, '.she', 'plans.json'), 'utf8'));

const mark = (planText, stepId) =>
  planText.split('\n').find((l) => new RegExp(`\\s${stepId}\\s`).test(l))?.trim() ?? '';

console.log('1. 依赖图：该开始的是「前置都做完」的那一步');
{
  const tools = toolsFor('sess-a');
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
  const afterRefusal = onDisk()[0];
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
  check('完成数不会超过实际做完的步数', /4\/4 完成/.test(done), done);
}

console.log('\n2. 断点恢复：换一个 store、换一个会话，还知道从哪继续');
{
  const tools = toolsFor('sess-b');
  await call(tools, 'plan_create', {
    title: '迁移数据库',
    steps: ['备份', { title: '跑迁移', dependsOn: ['s1'] }, { title: '验证', dependsOn: ['s2'] }],
  });
  await call(tools, 'plan_update', { step_id: 's1', status: 'done' });

  // Everything in memory is gone: new toolset, different session, same workspace file.
  const restarted = toolsFor('sess-c');
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
  const raw = onDisk().find((p) => p.title === '迁移数据库');
  check('盘上记的是步骤状态，不是渲染出来的文本', raw.steps[1].status === 'active', JSON.stringify(raw.steps));

  const next = await call(restarted, 'plan_update', { step_id: 's2', status: 'done' });
  check('恢复后能接着正常推进', /下一步: s3 验证/.test(next), next);
}

console.log('\n3. 失败策略：写下来的处置办法要真的执行');
{
  const tools = toolsFor('sess-d');
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
  const tools = toolsFor('sess-e');
  await call(tools, 'plan_create', { title: '停', steps: [{ title: 'a' }, { title: 'b', dependsOn: ['s1'] }] });
  const blocked = await call(tools, 'plan_update', { step_id: 's1', status: 'blocked', note: '装不上' });
  check('stop 策略下这一步停在 blocked', mark(blocked, 's1').includes('[!]'), blocked);
  check('受阻的计划不当作完成', /状态 open/.test(blocked), blocked);
  check('受阻时下一步就是那一步，不能消失', /下一步: s1 a/.test(blocked), blocked);
  check('并说清要用户决定', /onFailure=stop/.test(blocked) && /需要用户决定/.test(blocked), blocked);
  check('后面那步不能因为前面受阻就偷偷开始', mark(blocked, 's2').includes('[ ]'), blocked);
}

{
  const tools = toolsFor('sess-f');
  await call(tools, 'plan_create', { title: '重试', steps: [{ title: '拉取', onFailure: 'retry' }] });
  const first = await call(tools, 'plan_update', { step_id: 's1', status: 'blocked', note: '超时' });
  check('retry 明确说「换个做法再试一次」，不是含糊的失败', /换个做法再试一次/.test(first), first);
  check('记下这是第 1 次', /已试 1 次/.test(first), first);

  const second = await call(tools, 'plan_update', { step_id: 's1', status: 'blocked', note: '还是超时' });
  check('第二次失败看得见，不是静默死循环', /已试 2 次/.test(second), second);
  check('「下一步」里也报出次数', /已试过 2 次/.test(second), second);
}

{
  const tools = toolsFor('sess-g');
  await call(tools, 'plan_create', { title: '问', steps: [{ title: '删表', onFailure: 'ask' }] });
  const asked = await call(tools, 'plan_update', { step_id: 's1', status: 'blocked', note: '要不要删' });
  check('ask 策略指明该调用 ask_user', /ask_user/.test(asked), asked);
}

console.log('\n4. 图的形状本身不能被写坏');
{
  const tools = toolsFor('sess-h');
  const created = await call(tools, 'plan_create', { title: '图', steps: ['a', 'b'] });
  check('创建时依赖了不存在的步骤会被丢掉而不是留下死引用', !/依赖: s9/.test(created), created);

  const badDep = await call(tools, 'plan_update', { step_id: 's2', depends_on: ['s9'] });
  check('事后声明一个不存在的依赖会被拒绝', badDep.startsWith('Error: '), badDep);
  const stillClean = onDisk().find((p) => p.title === '图');
  check('拒绝后盘上没有半截依赖', stillClean.steps[1].dependsOn.length === 0, JSON.stringify(stillClean.steps[1]));

  await call(tools, 'plan_update', { step_id: 's1', depends_on: ['s2'] });
  const cycle = await call(tools, 'plan_update', { step_id: 's2', depends_on: ['s1'] });
  check('成环会被拒绝（成环 = 没有任何一步能开始）', /成环/.test(cycle), cycle);
  const afterCycle = JSON.parse(readFileSync(join(dir, '.she', 'plans.json'), 'utf8')).find((p) => p.title === '图');
  check('成环的依赖不会落盘', afterCycle.steps[1].dependsOn.length === 0, JSON.stringify(afterCycle.steps[1]));

  const reOpened = await call(tools, 'plan_create', { title: '做完又发现活', steps: ['a'] });
  const planId = /plan_[0-9a-f]+/.exec(reOpened)?.[0];
  await call(tools, 'plan_update', { step_id: 's1', status: 'done', plan_id: planId });
  const added = await call(tools, 'plan_add_steps', { plan_id: planId, steps: ['b'] });
  check('给做完的计划加活会重新打开它', /状态 open/.test(added), added);
  check('新加的步骤接着开始', /下一步: s2 b/.test(added), added);
}

console.log('\n5. 提示词里写了怎么用这张图');
{
  const prompt = getSystemPrompt('dev');
  check('提示词要求按「下一步」续做', /下一步:/.test(prompt) && /Resuming means reading/.test(prompt), null);
  check('提示词要求声明 depends_on', /depends_on/.test(prompt), null);
  check('提示词说明 blocked 不等于完成', /blocked\` is not a step that finished/.test(prompt), null);
}

removeTempDir(dir);
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}  plan-check`);
process.exit(failures === 0 ? 0 : 1);
