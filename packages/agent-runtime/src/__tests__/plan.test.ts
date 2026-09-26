/**
 * Plan store: durable, per-session progress tracking.
 *
 * The plan is what the agent uses to keep its own long-horizon work straight, so
 * the invariants that matter here are that a plan survives a restart and stays
 * visible to every conversation (a long task must not vanish when the chat
 * changes) — plus the
 * auto-advance behaviour, which is easy to break silently.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlanStore, renderPlan, createPlanTools } from '../plan-tools.js';
import type { StepStatus } from '../plan-tools.js';
import { classifyToolResult } from '../tool-result.js';

/**
 * Apply a legal transition and hand back the plan.
 *
 * `setStepStatus` reports a refusal instead of returning nothing, so a refusal here is a bug in
 * the test rather than something to swallow — the assertions below are about the resulting
 * state, not about whether the transition was allowed. Illegal transitions get their own tests.
 */
function setStep(store: PlanStore, planId: string, stepId: string, status: StepStatus, note?: string) {
  const r = store.setStepStatus(planId, stepId, status, note);
  assert.ok(r.ok, `setStepStatus 被拒绝: ${r.ok ? '' : r.reason}`);
  return r.plan;
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-plan-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('PlanStore', () => {
  it('first step starts active, the rest pending', () => {
    const store = new PlanStore(dir);
    const plan = store.create('收尾工作', ['分类', '提交'], '把未提交的改动整理好');
    assert.equal(plan.steps.length, 2);
    // The agent reads `active` as "do this now"; getting this wrong makes it
    // start from the wrong step.
    assert.equal(plan.steps[0].status, 'active', '第一步应为 active');
    assert.equal(plan.steps[1].status, 'pending', '其余应为 pending');
    assert.equal(plan.status, 'open');
  });

  it('survives a reload (durability)', () => {
    const a = new PlanStore(dir);
    const created = a.create('持久化', ['一步']);
    // A second store over the same directory stands in for a process restart.
    const b = new PlanStore(dir);
    const found = b.get(created.id);
    assert.ok(found, '重启后应能读回计划');
    assert.equal(found!.title, '持久化');
  });

  it('lists plans from every conversation', () => {
    const storeA = new PlanStore(dir, 'sess-A');
    const storeB = new PlanStore(dir, 'sess-B');
    const a = storeA.create('属于 A', ['x']);
    const b = storeB.create('属于 B', ['y']);
    const titles = storeA.list().map((p) => p.title).sort();
    assert.deepEqual(titles, ['属于 A', '属于 B']);
    assert.equal(storeB.get(a.id)?.title, '属于 A');
    assert.equal(storeA.active()?.id, a.id, '优先继续本会话自己的未完成计划');
    assert.equal(storeB.active()?.id, b.id);
    const updated = setStep(storeA, b.id, b.steps[0].id, 'done');
    assert.equal(updated?.status, 'done', '别的会话留下的计划也要能接着改');
  });

  it('an unbound store sees every plan', () => {
    new PlanStore(dir, 'sess-A').create('A 的', ['x']);
    new PlanStore(dir, 'sess-B').create('B 的', ['y']);
    assert.equal(new PlanStore(dir).list().length, 2);
  });

  it('completing a step auto-advances the next one', () => {
    const store = new PlanStore(dir);
    const p = store.create('两步', ['a', 'b']);
    setStep(store, p.id, p.steps[0].id, 'done');
    const after = store.get(p.id)!;
    assert.equal(after.steps[0].status, 'done');
    assert.equal(after.steps[1].status, 'active', '下一步应自动变为 active');
  });

  it('closes the plan once every step is done or dropped', () => {
    const store = new PlanStore(dir);
    const p = store.create('两步', ['a', 'b']);
    setStep(store, p.id, p.steps[0].id, 'done');
    setStep(store, p.id, p.steps[1].id, 'dropped');
    assert.equal(store.get(p.id)!.status, 'done', '全部结束时应自动收口');
  });

  it('a blocked step does not close the plan', () => {
    const store = new PlanStore(dir);
    const p = store.create('被阻塞', ['a']);
    setStep(store, p.id, p.steps[0].id, 'blocked', '等外部依赖');
    const after = store.get(p.id)!;
    assert.equal(after.status, 'open', '阻塞不应让计划变成完成');
    assert.equal(after.steps[0].note, '等外部依赖', 'note 应被保存');
  });

  it('addSteps appends and keeps existing steps', () => {
    const store = new PlanStore(dir);
    const p = store.create('增量', ['一']);
    const after = store.addSteps(p.id, ['二', '三'])!;
    assert.equal(after.steps.length, 3);
    assert.deepEqual(after.steps.map((s) => s.id), ['s1', 's2', 's3']);
    assert.equal(after.steps[0].title, '一', '原有步骤不应被动');
  });

  it('accepts a short plan id prefix', () => {
    const store = new PlanStore(dir);
    const p = store.create('前缀', ['x']);
    // The model often echoes a truncated id; resolving it is what makes
    // plan_update usable in practice.
    assert.ok(store.get(p.id.slice(0, 7)), '应能用 id 前缀解析');
  });

  it('empty titles are rejected rather than creating junk', () => {
    const store = new PlanStore(dir);
    const p = store.create('   ', ['', '  ', '有效步骤']);
    assert.equal(p.title, '未命名计划', '空标题应有兜底');
    assert.equal(p.steps.length, 1, '空步骤应被过滤');
  });

  it('active() returns the newest open plan only', () => {
    const store = new PlanStore(dir);
    const first = store.create('旧的', ['a']);
    store.create('新的', ['b']);
    store.setStatus(first.id, 'done');
    const active = store.active();
    assert.equal(active?.title, '新的', 'active 应跳过已完成的计划');
  });
});

/**
 * Declared dependencies and per-step failure policies.
 *
 * These are the invariants that make a plan resumable: which step may run now, and what the plan
 * itself said to do when one cannot be done. Both are silent when they break — a plan with a
 * satisfied-looking `4/4` and a plan stuck on a step nobody can start look the same to the model.
 */
describe('PlanStore 依赖与失败策略', () => {
  it('前置没完成时不能开始，也不能标完成', () => {
    const store = new PlanStore(dir);
    const p = store.create('有依赖', [{ title: 'a' }, { title: 'b', dependsOn: ['s1'] }]);
    assert.equal(p.steps[0].status, 'active', '没有前置的第一步应直接开始');
    assert.equal(p.steps[1].status, 'pending');
    assert.deepEqual(p.steps[1].dependsOn, ['s1']);

    for (const status of ['active', 'done'] as const) {
      const refused = store.setStepStatus(p.id, 's2', status);
      assert.equal(refused.ok, false, `${status} 应被拒绝`);
      assert.match(refused.ok ? '' : refused.reason, /s1/, '拒绝要说清是哪一步挡着');
    }
    const after = store.get(p.id)!;
    assert.equal(after.steps[1].status, 'pending', '被拒绝后状态不能变');
    assert.equal(after.steps[0].status, 'active', '也不能顺手把前置改掉');
  });

  it('手动跳过一步，依赖它的步骤也会被跳过（不能假装前置做完了）', () => {
    const store = new PlanStore(dir);
    const p = store.create('跳过的前置', [{ title: 'a' }, { title: 'b', dependsOn: ['s1'] }]);
    setStep(store, p.id, 's1', 'dropped');
    const after = store.get(p.id)!;
    assert.equal(after.steps[1].status, 'dropped', '前置没了，依赖它的步骤不能留着等');
    assert.equal(store.setStepStatus(p.id, 's2', 'done').ok, false, 'dropped 的前置不是 done');
  });

  it('给做完的计划加新步骤会重新打开它', () => {
    const store = new PlanStore(dir);
    const p = store.create('做完又发现活', ['a']);
    setStep(store, p.id, 's1', 'done');
    assert.equal(store.get(p.id)!.status, 'done');

    store.addSteps(p.id, ['b']);
    const after = store.get(p.id)!;
    assert.equal(after.status, 'open', '闭掉的计划加了活就该重新是进行中');
    assert.equal(after.steps[1].status, 'active', '新步骤应直接开始');
    assert.equal(store.active()?.id, p.id, 'active() 要能再找到它');
  });

  it('完成一步后激活的是「前置都做完」的那一步，不是列表里的下一步', () => {
    const store = new PlanStore(dir);
    const p = store.create('菱形', [
      'a',
      { title: 'b', dependsOn: ['s1'] },
      { title: 'c', dependsOn: ['s1'] },
      { title: 'd', dependsOn: ['s2', 's3'] },
    ]);
    const status = (id: string) => store.get(p.id)!.steps.find((s) => s.id === id)!.status;

    setStep(store, p.id, 's1', 'done');
    assert.equal(status('s2'), 'active');
    assert.equal(status('s4'), 'pending', '两条前置只完成一条时不能开始');

    setStep(store, p.id, 's2', 'done');
    assert.equal(status('s3'), 'active', 's2 完成后该轮到 s3，而不是等着的 s4');
    assert.equal(status('s4'), 'pending');

    setStep(store, p.id, 's3', 'done');
    assert.equal(status('s4'), 'active', '两条前置都完成后才轮到 s4');
  });

  it('同一时间只有一步在进行中', () => {
    const store = new PlanStore(dir);
    const p = store.create('并行', ['a', 'b']);
    setStep(store, p.id, 's2', 'active');
    const after = store.get(p.id)!;
    assert.equal(after.steps.filter((s) => s.status === 'active').length, 1, '不能有两个 [>]');
    assert.equal(after.steps[0].status, 'pending', '让位的那一步回到 pending');
  });

  it('依赖不存在的步骤会被拒绝，并保持原样', () => {
    const store = new PlanStore(dir);
    const p = store.create('坏依赖', ['a', 'b']);
    const r = store.setStepStatus(p.id, 's2', 'pending', undefined, { dependsOn: ['s9'] });
    assert.equal(r.ok, false);
    assert.match(r.ok ? '' : r.reason, /s9/);
    assert.deepEqual(store.get(p.id)!.steps[1].dependsOn, [], '拒绝后不能留下半截依赖');
  });

  it('依赖成环会被拒绝，而且不落盘', () => {
    const store = new PlanStore(dir);
    const p = store.create('环', ['a', 'b']);
    assert.equal(store.setStepStatus(p.id, 's1', 'pending', undefined, { dependsOn: ['s2'] }).ok, true);
    const r = store.setStepStatus(p.id, 's2', 'pending', undefined, { dependsOn: ['s1'] });
    assert.equal(r.ok, false, 's1→s2→s1 没有一步能开始');
    assert.deepEqual(new PlanStore(dir).get(p.id)!.steps[1].dependsOn, [], '成环的依赖不能写下去');
  });

  it('onFailure=skip 会把依赖它的步骤一起跳过，并写清原因', () => {
    const store = new PlanStore(dir);
    const p = store.create('跳过', [
      'a',
      { title: 'b', dependsOn: ['s1'], onFailure: 'skip' },
      { title: 'c', dependsOn: ['s2'] },
    ]);
    setStep(store, p.id, 's1', 'done');
    const r = store.setStepStatus(p.id, 's2', 'blocked', '依赖装不上');
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok ? r.dropped : [], ['s3'], '依赖它的步骤要一起跳过');

    const after = store.get(p.id)!;
    assert.equal(after.steps[1].status, 'dropped');
    assert.match(after.steps[1].note!, /skip/, '要说明是策略跳过的');
    assert.match(after.steps[2].note!, /s2/, '被牵连的步骤要写清是谁害的');
    assert.equal(after.status, 'done', '剩下的都结束了，计划要收口');
  });

  it('onFailure=stop 时停下来，并说清卡在哪一步', () => {
    const store = new PlanStore(dir);
    const p = store.create('停止', ['a', { title: 'b', dependsOn: ['s1'] }]);
    setStep(store, p.id, 's1', 'blocked', '装不上');

    const after = store.get(p.id)!;
    assert.equal(after.status, 'open', '受阻不等于做完');
    assert.equal(after.steps[1].status, 'pending', '后面那步不能偷偷开始');

    const next = store.nextStep(p.id)!;
    assert.equal(next.step.id, 's1');
    assert.match(next.why, /onFailure=stop/);
  });

  it('retry 会记下试了几次，重复重试不是静默死循环', () => {
    const store = new PlanStore(dir);
    const p = store.create('重试', [{ title: 'a', onFailure: 'retry' }]);
    setStep(store, p.id, 's1', 'blocked', '连不上');
    assert.match(store.nextStep(p.id)!.why, /换个做法再试一次/);
    assert.match(renderPlan(store.get(p.id)!), /失败策略: retry  已试 1 次/);

    store.setStepStatus(p.id, 's1', 'blocked', '还是连不上');
    assert.match(renderPlan(store.get(p.id)!), /已试 2 次/, '第二次失败要看得出来');
    assert.match(store.nextStep(p.id)!.why, /已试过 2 次/, '同一件事试了两次要写进「下一步」');
  });

  it('ask 策略会明说要问用户', () => {
    const store = new PlanStore(dir);
    const p = store.create('问', [{ title: '删库', onFailure: 'ask' }]);
    setStep(store, p.id, 's1', 'blocked', '需要用户确认');
    assert.match(store.nextStep(p.id)!.why, /ask_user/, '该问用户时不能自己猜');
  });

  it('nextStep 在计划跑完时给不出东西', () => {
    const store = new PlanStore(dir);
    const p = store.create('收口', ['a']);
    setStep(store, p.id, 's1', 'done');
    assert.equal(store.nextStep(p.id), undefined);
  });

  it('创建时激活的是「没有前置」的那一步，而不是列表里的第一步', () => {
    const store = new PlanStore(dir);
    const p = store.create('前向依赖', [{ title: 'b', dependsOn: ['s2'] }, { title: 'a' }]);
    assert.equal(p.steps[1].status, 'active', 's1 还在等 s2，能开始的是 s2');
    assert.equal(p.steps[0].status, 'pending');
  });

  it('指出「在等一个永远不会来的前置」', () => {
    const store = new PlanStore(dir);
    const p = store.create('等前置', ['a']);
    setStep(store, p.id, 's1', 'dropped');
    // A step added afterwards can still name the dropped step; that is a real plan state, and it
    // has to be reported rather than silently treated as schedulable.
    store.addSteps(p.id, [{ title: 'b', dependsOn: ['s1'] }]);

    const next = store.nextStep(p.id)!;
    assert.equal(next.step.id, 's2');
    assert.match(next.why, /s1 现在是 dropped/, `实际: ${next.why}`);
  });

  it('老的计划文件（没有 dependsOn / onFailure）照常读', () => {
    mkdirSync(join(dir, '.she'), { recursive: true });
    writeFileSync(join(dir, '.she', 'plans.json'), JSON.stringify([{
      id: 'plan_old0001',
      title: '旧计划',
      status: 'open',
      steps: [{ id: 's1', title: 'a', status: 'active', updatedAt: '2020-01-01T00:00:00.000Z' }],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }]), 'utf8');

    const p = new PlanStore(dir).get('plan_old0001')!;
    assert.deepEqual(p.steps[0].dependsOn, [], '默认无依赖');
    assert.equal(p.steps[0].onFailure, 'stop', '默认停');
    assert.ok(renderPlan(p).includes('下一步: s1'), '老计划也要能给出下一步');
  });
});

describe('renderPlan', () => {
  it('distinguishes step states and shows progress', () => {
    const store = new PlanStore(dir);
    const p = store.create('渲染', ['做完的', '没做的'], '目标说明');
    setStep(store, p.id, p.steps[0].id, 'done');
    const text = renderPlan(store.get(p.id)!);
    assert.ok(text.includes('渲染'), '应含标题');
    assert.ok(text.includes('目标说明'), '应含目标');
    assert.match(text, /1\/2/, `应显示 1/2 进度，实际: ${text.slice(0, 140)}`);

    const doneLine = text.split('\n').find((l) => l.includes('做完的'))!;
    const todoLine = text.split('\n').find((l) => l.includes('没做的'))!;
    assert.notEqual(doneLine.trim(), todoLine.trim(), '已完成与未完成的行必须可区分');
  });

  it('把依赖、失败策略和「下一步」都渲染出来', () => {
    const store = new PlanStore(dir);
    const p = store.create('断点', [
      'a',
      { title: 'b', dependsOn: ['s1'], onFailure: 'skip' },
    ]);
    const text = renderPlan(store.get(p.id)!);
    assert.match(text, /依赖: s1/, '依赖要看得见，否则不知道为什么还不能开始');
    assert.match(text, /失败策略: skip/);
    assert.match(text, /下一步: s1 a/, '重启后第一眼要能看出从哪继续');

    setStep(store, p.id, 's1', 'done');
    assert.match(renderPlan(store.get(p.id)!), /下一步: s2 b/);
  });

  it('没有默认值的步骤不印噪声（普通计划读起来和以前一样）', () => {
    const store = new PlanStore(dir);
    const p = store.create('普通', ['a', 'b']);
    const text = renderPlan(store.get(p.id)!);
    assert.ok(!text.includes('依赖:'), '没有依赖就不该印「依赖:」');
    assert.ok(!text.includes('失败策略:'), '默认策略不该印出来');
  });

  it('卡住的计划渲染成「卡住」，不是「做完了」', () => {
    const store = new PlanStore(dir);
    const p = store.create('卡住', ['a']);
    setStep(store, p.id, 's1', 'blocked', '装不上');
    const text = renderPlan(store.get(p.id)!);
    assert.match(text, /下一步: s1/, '受阻的步骤仍要是「下一步」，不能消失');
    assert.ok(!text.includes('计划已收口'), '受阻的计划不能被读成完成');
  });
});

describe('plan tools', () => {
  it('exposes the three plan tools by their expected names', () => {
    const tools = createPlanTools(dir, 'sess-1');
    const names = tools.definitions.map((d) => d.name);
    // The agent calls these by name; a rename silently breaks the loop.
    for (const expected of ['plan_create', 'plan_update', 'plan_list']) {
      assert.ok(names.includes(expected), `缺少工具 ${expected}，实际: ${names.join(', ')}`);
    }
  });

  it('create then list round-trips', async () => {
    const tools = createPlanTools(dir, 'sess-1');
    const created = await tools.execute('plan_create', { title: 'T', goal: 'G', steps: ['s1'] });
    assert.match(created, /Plan plan_/, `create 应返回计划，实际: ${created.slice(0, 100)}`);
    const listed = await tools.execute('plan_list', {});
    assert.ok(listed.includes('T'), 'list 应包含刚创建的计划');
  });

  it('unknown tool returns an error string instead of throwing', async () => {
    const tools = createPlanTools(dir, 'sess-1');
    const out = await tools.execute('plan_nope', {});
    assert.match(out, /unknown/i, `应返回错误说明，实际: ${out}`);
  });

  it('a tool call with missing arguments does not throw', async () => {
    const tools = createPlanTools(dir, 'sess-1');
    // The model occasionally emits an incomplete call; the loop must survive it.
    const out = await tools.execute('plan_create', {});
    assert.equal(typeof out, 'string', '应返回字符串而不是抛异常');
  });

  it('plan_create 接受带依赖和失败策略的步骤', async () => {
    const tools = createPlanTools(dir, 'sess-1');
    const out = await tools.execute('plan_create', {
      title: '带图',
      steps: ['准备', { title: '构建', dependsOn: ['s1'], onFailure: 'skip' }],
    });
    assert.match(out, /下一步: s1 准备/, `实际: ${out.slice(0, 200)}`);
    assert.match(out, /依赖: s1/);
  });

  it('plan_update 拒绝越序开始，并给出可分类的原因', async () => {
    const tools = createPlanTools(dir, 'sess-1');
    await tools.execute('plan_create', {
      title: '越序',
      steps: ['准备', { title: '构建', dependsOn: ['s1'] }],
    });
    const out = await tools.execute('plan_update', { step_id: 's2', status: 'active' });
    assert.match(out, /^Error: /, `应是一条错误，实际: ${out.slice(0, 120)}`);
    assert.match(out, /s1/, '要说清是谁挡着');
    /*
     * Classified as a precondition rather than "unknown": the arguments were fine and retrying
     * them changes nothing — what has to happen first is the step in the way. An unknown
     * verdict would mean the model is told "something failed" with no way to act on it.
     */
    assert.equal(classifyToolResult('plan_update', out).kind, 'precondition');
  });

  it('plan_update 可以只声明依赖，不动状态', async () => {
    const tools = createPlanTools(dir, 'sess-1');
    await tools.execute('plan_create', { title: '后声明', steps: ['a', 'b'] });
    const out = await tools.execute('plan_update', { step_id: 's2', depends_on: ['s1'] });
    assert.match(out, /依赖: s1/);
    assert.ok(!out.startsWith('Error'), `不该报错: ${out.slice(0, 160)}`);
  });

  it('plan_update 什么都不给是用法错误', async () => {
    const tools = createPlanTools(dir, 'sess-1');
    await tools.execute('plan_create', { title: '空调用', steps: ['a'] });
    const out = await tools.execute('plan_update', { step_id: 's1' });
    assert.match(out, /^Error: /);
    assert.equal(classifyToolResult('plan_update', out).kind, 'invalid_args');
  });

  it('plan_list 里也带着下一步（换会话后靠它接着做）', async () => {
    const tools = createPlanTools(dir, 'sess-1');
    await tools.execute('plan_create', { title: '列表', steps: ['a', 'b'] });
    const listed = await tools.execute('plan_list', {});
    assert.match(listed, /下一步: s1 a/);
  });
});

/**
 * The reply to `plan_update` is sent once per step of progress, a dozen times on a long task, so
 * what it repeats is what the task pays for again and again.
 *
 * The contract these lock down: the reply lists only the steps THIS call moved (including side
 * effects: auto-activation, a step sent back to pending, cascaded drops), plus progress and the
 * next step; nothing is lost — `plan_get` / `plan_list` still print every step and every note.
 */
describe('plan_update 的回显瘦身', () => {
  it('只列这次改动过的步骤，其余步骤不重复回显', async () => {
    const tools = createPlanTools(dir, 'sess-note');
    await tools.execute('plan_create', { title: '瘦身', steps: ['a', 'b', 'c'] });
    await tools.execute('plan_update', { step_id: 's1', status: 'done', note: '第一个发现' });
    const out = await tools.execute('plan_update', { step_id: 's2', status: 'done', note: '第二个发现' });

    assert.ok(out.includes('第二个发现'), `本次备注必须在: ${out}`);
    assert.ok(!out.includes('第一个发现'), `上次的备注不该重复回显: ${out}`);
    // Compact reply: untouched steps are not repeated at all; plan_get has the whole plan.
    assert.doesNotMatch(out, /s1 a/, `没动过的步骤不该回显: ${out}`);
    assert.match(out, /\[x\] s2 b（active → done）/);
    assert.match(out, /\[>\] s3 c（pending → active）/, '完成时自动激活的下一步也要看得见');
    assert.match(out, /进度 2\/3/);
    assert.match(out, /下一步: s3 c/);
    assert.match(out, /plan_get/);
  });

  it('备注没有丢：plan_list 全量印出来', async () => {
    const tools = createPlanTools(dir, 'sess-note2');
    await tools.execute('plan_create', { title: '留底', steps: ['a', 'b'] });
    await tools.execute('plan_update', { step_id: 's1', status: 'done', note: '第一个发现' });
    const listed = await tools.execute('plan_list', {});
    assert.ok(
      listed.includes('第一个发现'),
      `备注只该是不回显，不该是被删掉: ${listed}`,
    );
  });

  it('start 把上一步踢回 pending 时，那一步也算「这次动过」', async () => {
    const tools = createPlanTools(dir, 'sess-note3');
    await tools.execute('plan_create', { title: '换手', steps: ['a', 'b'] });
    await tools.execute('plan_update', { step_id: 's1', status: 'active', note: '在做 a' });
    const out = await tools.execute('plan_update', { step_id: 's2', status: 'active', note: '改做 b' });
    assert.match(out, /\[ \] s1 a/, 's1 被踢回 pending，状态变化要看得见');
    assert.ok(out.includes('改做 b'), `本次备注必须在: ${out}`);
  });

  it('plan_add_steps 只印新加步骤的备注', async () => {
    const tools = createPlanTools(dir, 'sess-note4');
    const created = await tools.execute('plan_create', { title: '加活', steps: ['a'] });
    const planId = /plan_[0-9a-f]+/.exec(created)![0];
    await tools.execute('plan_update', { step_id: 's1', status: 'done', note: '第一步的旧备注' });
    const added = await tools.execute('plan_add_steps', { plan_id: planId, steps: ['b'] });
    assert.ok(!added.includes('第一步的旧备注'), `旧备注不该在加步骤时再印一次: ${added}`);
    assert.match(added, /下一步: s2 b/);
  });

  it('长备注只回显一小截，plan_get 给全文', async () => {
    const tools = createPlanTools(dir, 'sess-note5');
    await tools.execute('plan_create', { title: '长备注', steps: ['a', 'b'] });
    const long = `证据：${'很长的输出。'.repeat(40)}结尾标记`;
    const out = await tools.execute('plan_update', { step_id: 's1', status: 'done', note: long });
    assert.ok(!out.includes('结尾标记'), `长备注不该整段回显: ${out}`);
    assert.match(out, /s1 a（active → done）  — 证据：/);
    const full = await tools.execute('plan_get', {});
    assert.ok(full.includes('结尾标记'), 'plan_get 要印全文备注');
    assert.match(full, /\[x\] s1 a/);
    assert.match(full, /\[>\] s2 b/);
  });

  it('进度不把 dropped 算进分母，并单独说明', async () => {
    const tools = createPlanTools(dir, 'sess-note6');
    await tools.execute('plan_create', { title: '放弃', steps: ['a', 'b', 'c'] });
    await tools.execute('plan_update', { step_id: 's1', status: 'done' });
    const out = await tools.execute('plan_update', { step_id: 's3', status: 'dropped', note: '不需要了' });
    assert.match(out, /进度 1\/2（另有 1 步已放弃，不计入）/, out);
    assert.match(out, /s3 c（pending → dropped）  — 不需要了/);
    assert.match(out, /下一步: s2 b/);
    assert.doesNotMatch(out, /s1 a/);
  });

  it('全部做完时说计划已收口', async () => {
    const tools = createPlanTools(dir, 'sess-note7');
    await tools.execute('plan_create', { title: '收口', steps: ['a'] });
    const out = await tools.execute('plan_update', { step_id: 's1', status: 'done' });
    assert.match(out, /进度 1\/1/);
    assert.match(out, /计划已收口/);
    assert.match(out, /（计划状态 done）/);
  });

  it('回显比整份计划短得多（多步、带备注的计划）', async () => {
    const tools = createPlanTools(dir, 'sess-note8');
    await tools.execute('plan_create', { title: '体积', steps: Array.from({ length: 10 }, (_, i) => `步骤${i + 1}`) });
    for (let i = 1; i <= 8; i++) {
      await tools.execute('plan_update', { step_id: `s${i}`, status: 'done', note: `第${i}步的发现：${'细节'.repeat(30)}` });
    }
    const out = await tools.execute('plan_update', { step_id: 's9', status: 'done', note: '第9步的发现' });
    const full = await tools.execute('plan_get', {});
    assert.ok(out.length * 3 < full.length, `回显 ${out.length} 字，全量 ${full.length} 字`);
  });

  it('plan_get 没有计划 / 找不到计划时给出说明，而不是抛异常', async () => {
    const tools = createPlanTools(dir, 'sess-note9');
    assert.equal(await tools.execute('plan_get', {}), 'No plans yet.');
    assert.match(await tools.execute('plan_get', { plan_id: 'plan_nope' }), /^Error: plan not found/);
  });
});

/**
 * The delivery template.
 *
 * A hand-off is where the agent's own summary becomes the user's only record of what happened,
 * so the parts that are checked here are the ones a summary can lie about by omission: a
 * conclusion with no evidence behind it, and `done` over work that is not finished.
 */
describe('交付模板', () => {
  const evidence = ['shell: pnpm test → exit code: 0'];

  /**
   * Write, then read back the artifact the tool reported.
   *
   * From the reported path rather than "the newest file": names carry a second-resolution
   * timestamp, two artifacts written in one test would tie, and a directory listing would then
   * assert against whichever one happened to sort last.
   *
   * `evidence` is NOT injected here on purpose: one of the tests is about omitting it, and a
   * helper that quietly supplies it would make that test pass for the wrong reason.
   */
  async function report(title: string, args: Record<string, unknown> = {}) {
    const tools = createPlanTools(dir, 'sess-1');
    const out = await tools.execute('report_write', { kind: 'delivery', title, ...args });
    const rel = /\.she\/reports\/[^\s]+\.md/.exec(out)?.[0];
    const text = rel ? readFileSync(join(dir, rel), 'utf8') : '';
    return { tools, out, text };
  }

  it('没有结论或证据的交付不是交付', async () => {
    const noConclusion = await report('T', { status: 'done', evidence });
    assert.match(noConclusion.out, /^Error: /);
    assert.match(noConclusion.out, /conclusion/);

    const noEvidence = await report('T', { status: 'done', conclusion: '做完了' });
    assert.match(noEvidence.out, /^Error: /);
    assert.match(noEvidence.out, /evidence/);
    assert.equal(
      classifyToolResult('report_write', noEvidence.out).kind,
      'invalid_args',
      '参数问题是模型能自己改的，不该归成 unknown',
    );
  });

  it('详版要求显式给出假设和风险（空数组是结论，不是遗漏）', async () => {
    const missing = await report('T', { status: 'done', mode: 'full', conclusion: '做完了', evidence });
    assert.match(missing.out, /^Error: /);
    assert.match(missing.out, /assumptions/);

    const empty = await report('T', {
      status: 'done', mode: 'full', conclusion: '做完了', evidence, assumptions: [], risks: [],
    });
    assert.ok(!empty.out.startsWith('Error'), `空数组应被接受: ${empty.out.slice(0, 160)}`);
  });

  it('有未确认的项就不能写 done', async () => {
    const { out } = await report('T', { status: 'done', conclusion: '做完了', evidence, open: ['线上没跑'] });
    assert.match(out, /^Error: /);
    assert.match(out, /线上没跑/, '要说清是哪一项没确认');
    assert.equal(classifyToolResult('report_write', out).kind, 'invalid_args');
  });

  it('没有待确认却写 needs_confirmation 也是错的', async () => {
    const { out } = await report('T', { status: 'needs_confirmation', conclusion: '做完了', evidence });
    assert.match(out, /^Error: /);
  });

  it('本会话计划没做完时不能交 done，做完才行', async () => {
    const tools = createPlanTools(dir, 'sess-1');
    await tools.execute('plan_create', { title: '迁移', steps: ['备份', '验证'] });
    await tools.execute('plan_update', { step_id: 's1', status: 'done' });

    const refused = await tools.execute('report_write', {
      kind: 'delivery', title: 'T', status: 'done', conclusion: '做完了', evidence,
    });
    assert.match(refused, /^Error: /);
    assert.match(refused, /s2 验证/, '要说清还剩哪一步');
    assert.equal(
      classifyToolResult('report_write', refused).kind,
      'precondition',
      '这是状态前提没满足，不是参数写错',
    );

    await tools.execute('plan_update', { step_id: 's2', status: 'done' });
    const ok = await tools.execute('report_write', {
      kind: 'delivery', title: 'T', status: 'done', conclusion: '做完了', evidence,
    });
    assert.ok(!ok.startsWith('Error'), `计划做完后应该通过: ${ok.slice(0, 200)}`);
  });

  it('别的会话没做完的计划不拦这次交付', async () => {
    const other = createPlanTools(dir, 'sess-9');
    await other.execute('plan_create', { title: '别人的活', steps: ['a', 'b'] });

    const { out } = await report('T', { status: 'done', conclusion: '做完了', evidence });
    assert.ok(
      !out.startsWith('Error'),
      `别会话的计划不该拦住交付（否则模型会学会把步骤标 done 来解锁）: ${out.slice(0, 200)}`,
    );
  });

  it('简版不印空小节，详版印（无）', async () => {
    const brief = await report('简版', { status: 'partial', conclusion: '做了一半', evidence, open: ['回归没跑'] });
    assert.ok(!brief.out.startsWith('Error'), brief.out.slice(0, 160));
    assert.ok(!brief.text.includes('## 假设'), '简版没有假设就不该印这一节');
    assert.ok(brief.text.includes('## 待确认'), '待确认这一节始终要在，它是交付的底线');

    const full = await report('详版', {
      status: 'partial', mode: 'full', conclusion: '做了一半', evidence, assumptions: [], risks: [], open: ['回归没跑'],
    });
    assert.ok(!full.out.startsWith('Error'), full.out.slice(0, 160));
    assert.ok(full.text.includes('## 假设') && full.text.includes('（无）'), '详版空小节要印出来，不能消失');
  });

  it('产物里带上计划里还没做完的步骤', async () => {
    const tools = createPlanTools(dir, 'sess-1');
    await tools.execute('plan_create', { title: '迁移', steps: ['备份', '验证'] });
    await tools.execute('plan_update', { step_id: 's1', status: 'done' });

    const out = await tools.execute('report_write', {
      kind: 'delivery', title: 'T', status: 'partial', conclusion: '做了一半', evidence, open: ['验证没做'],
    });
    assert.ok(!out.startsWith('Error'), out.slice(0, 160));
    const rel = /\.she\/reports\/[^\s]+\.md/.exec(out)![0];
    const text = readFileSync(join(dir, rel), 'utf8');
    assert.ok(text.includes('计划里还没做完的步骤'), '不带计划状态的话，读者得自己去翻');
    assert.match(text, /s2 验证 \[active\]/, '状态要真实（s1 完成后 s2 已经开始了）');
  });

  it('kind=report 不走交付模板', async () => {
    const tools = createPlanTools(dir, 'sess-1');
    const out = await tools.execute('report_write', {
      title: '分析',
      sections: [{ heading: '发现', body: '第一点' }],
    });
    assert.match(out, /Report written/);
    const rel = /\.she\/reports\/[^\s]+\.md/.exec(out)![0];
    const text = readFileSync(join(dir, rel), 'utf8');
    assert.ok(!text.includes('交付状态'), 'report 不声称交付状态');
    assert.ok(text.includes('## 发现'));
  });
});
