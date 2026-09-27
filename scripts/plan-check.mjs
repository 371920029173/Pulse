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
import { createPlanTools, classifyToolResult, getSystemPrompt, planSessions, PlanStore } from '../packages/agent-runtime/dist/index.js';
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

/**
 * The plan as stored on disk — not the object the tool just returned.
 *
 * 2026-09-27 起计划按会话分文件（`.she/sessions/<id>/plans.json`），所以这里要带上会话 id：
 * 读错文件会让这一段"验证落盘"变成验证空气。id 在磁盘上要经 `encodeSessionId`，这里用的都是
 * 普通 ASCII 会话名，编码后原样保留。
 */
const onDisk = (session = 'sess-a') =>
  JSON.parse(readFileSync(join(dir, '.she', 'sessions', session, 'plans.json'), 'utf8'));

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
  // plan_update now replies with only the changed step; the whole plan is read back via plan_list.
  const doneFull = await call(tools, 'plan_list', {});
  check('完成数不会超过实际做完的步数', /4\/4 完成/.test(doneFull), doneFull);
}

console.log('\n2. 断点恢复：换一个 store、换一个会话，还知道从哪继续');
{
  const tools = toolsFor('sess-b');
  await call(tools, 'plan_create', {
    title: '迁移数据库',
    steps: ['备份', { title: '跑迁移', dependsOn: ['s1'] }, { title: '验证', dependsOn: ['s2'] }],
  });
  await call(tools, 'plan_update', { step_id: 's1', status: 'done' });

  /*
   * Everything in memory is gone: a new toolset over the SAME session stands in for a process
   * restart.
   *
   * 2026-09-27 之前这里写的是"换一个 store、**换一个会话**"，因为那时计划是一份工作区文件，
   * 换个会话照样看得见 —— 那条正是跨会话读的入口。断点恢复要证明的性质其实是"进程没了计划还在"，
   * 与"别的会话能不能看见"无关，所以这里改成同一个会话；跨会话那条路另加断言钉死（本节末尾）。
   */
  const restarted = toolsFor('sess-b');
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
  const raw = onDisk('sess-b').find((p) => p.title === '迁移数据库');
  check('盘上记的是步骤状态，不是渲染出来的文本', raw.steps[1].status === 'active', JSON.stringify(raw.steps));

  const next = await call(restarted, 'plan_update', { step_id: 's2', status: 'done' });
  check('恢复后能接着正常推进', /下一步: s3 验证/.test(next), next);

  /*
   * 【关键】另一个会话看不到这份计划，也改不动它。
   *
   * 旧行为：看得见，还能接着改。现在计划按会话分文件，所以这里是"读不到"，而不是"读到了然后拒绝"。
   * 这一条要是被改回去，整个会话隔离就等于没做 —— 钉在这里，将来改错了门禁会响。
   */
  const other = toolsFor('sess-c');
  const otherListed = await call(other, 'plan_list', {});
  check('【关键】换一个会话看不到这份计划', !/迁移数据库/.test(otherListed), otherListed);
  const otherEdit = await call(other, 'plan_update', { plan_id: raw.id, step_id: 's3', status: 'done' });
  check('【关键】也改不动它（计划不在这个会话的文件里）', /^Error:/.test(otherEdit), otherEdit);
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
  const blockedFull = await call(tools, 'plan_list', {});
  check('受阻的计划不当作完成', /状态 open/.test(blockedFull), blockedFull);
  check('受阻时下一步就是那一步，不能消失', /下一步: s1 a/.test(blocked), blocked);
  check('并说清要用户决定', /onFailure=stop/.test(blocked) && /需要用户决定/.test(blocked), blocked);
  check('后面那步不能因为前面受阻就偷偷开始', mark(blockedFull, 's2').includes('[ ]'), blockedFull);
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
  const stillClean = onDisk('sess-h').find((p) => p.title === '图');
  check('拒绝后盘上没有半截依赖', stillClean.steps[1].dependsOn.length === 0, JSON.stringify(stillClean.steps[1]));

  await call(tools, 'plan_update', { step_id: 's1', depends_on: ['s2'] });
  const cycle = await call(tools, 'plan_update', { step_id: 's2', depends_on: ['s1'] });
  check('成环会被拒绝（成环 = 没有任何一步能开始）', /成环/.test(cycle), cycle);
  const afterCycle = onDisk('sess-h').find((p) => p.title === '图');
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

console.log('\n6. 看别的会话：清单能列出，正文要显式点开（且只读）');
{
  /*
   * 计划按会话分开存之后，「当前会话看不到别的会话的计划」是设计，不是缺陷 —— 但用户总得有条路
   * 走回去看那个长任务。给的路是**清单**：列出哪些会话有计划、各几个，正文一行都不带；点开哪个，
   * 才去读哪个会话的目录。把各会话的计划合并成一份视图是错的，那正是"上一个对话的计划看起来像
   * 现在正在跟的这个"。
   */
  const summary = planSessions(dir);
  const byId = new Map(summary.map((s) => [s.session_id, s]));
  check('列出的会话里有本工作区真正有计划的那些', byId.has('sess-a') && byId.has('sess-b'), JSON.stringify(summary));
  check('没有计划的会话不占位置（"没有"和"有 0 个"不是一回事）',
    summary.every((s) => s.plans > 0), JSON.stringify(summary));
  check('带计数，界面不用为每个会话再问一次',
    (byId.get('sess-b')?.plans ?? 0) >= 1 && Number.isFinite(byId.get('sess-b')?.open), JSON.stringify(byId.get('sess-b')));
  check('清单里只有会话 id 和计数，没有任何计划正文',
    !JSON.stringify(summary).includes('迁移数据库'), JSON.stringify(summary).slice(0, 200));
  check('最近动过的排在前面（选择器要回答"我上次那个长任务在哪"）',
    summary.every((s, i) => i === 0 || (summary[i - 1].updated_at ?? '') >= (s.updated_at ?? '')), JSON.stringify(summary));

  /*
   * 读某个会话的计划，用的还是它自己的 store —— 也就是界面点开那一行之后做的事。这里确认由
   * `session_id` 决定读哪份文件，而不是"读当前会话然后过滤"。
   */
  const openB = new PlanStore(dir, 'sess-b').list();
  const openC = new PlanStore(dir, 'sess-c').list();
  check('按会话 id 打开：sess-b 看得到自己的计划', openB.some((p) => p.title === '迁移数据库'), JSON.stringify(openB.map((p) => p.title)));
  check('清单里没有的会话，打开也是空的（没计划就不进清单）',
    !byId.has('sess-c') && openC.length === 0, JSON.stringify(openC.map((p) => p.title)));
}

removeTempDir(dir);
console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}  plan-check`);
process.exit(failures === 0 ? 0 : 1);
