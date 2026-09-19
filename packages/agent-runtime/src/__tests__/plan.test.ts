/**
 * Plan store: durable, per-session progress tracking.
 *
 * The plan is what the agent uses to keep its own long-horizon work straight, so
 * the invariants that matter here are scoping (plans must not leak between
 * conversations) and durability (a plan must survive a restart) — plus the
 * auto-advance behaviour, which is easy to break silently.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlanStore, renderPlan, createPlanTools } from '../plan-tools.js';

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

  it('scopes plans to their conversation', () => {
    const storeA = new PlanStore(dir, 'sess-A');
    const storeB = new PlanStore(dir, 'sess-B');
    storeA.create('属于 A', ['x']);
    storeB.create('属于 B', ['y']);
    assert.equal(storeA.list().length, 1);
    assert.equal(storeA.list()[0].title, '属于 A');
    assert.equal(storeB.list()[0].title, '属于 B');
  });

  it('an unbound store sees every plan', () => {
    new PlanStore(dir, 'sess-A').create('A 的', ['x']);
    new PlanStore(dir, 'sess-B').create('B 的', ['y']);
    assert.equal(new PlanStore(dir).list().length, 2);
  });

  it('completing a step auto-advances the next one', () => {
    const store = new PlanStore(dir);
    const p = store.create('两步', ['a', 'b']);
    store.updateStep(p.id, p.steps[0].id, 'done');
    const after = store.get(p.id)!;
    assert.equal(after.steps[0].status, 'done');
    assert.equal(after.steps[1].status, 'active', '下一步应自动变为 active');
  });

  it('closes the plan once every step is done or dropped', () => {
    const store = new PlanStore(dir);
    const p = store.create('两步', ['a', 'b']);
    store.updateStep(p.id, p.steps[0].id, 'done');
    store.updateStep(p.id, p.steps[1].id, 'dropped');
    assert.equal(store.get(p.id)!.status, 'done', '全部结束时应自动收口');
  });

  it('a blocked step does not close the plan', () => {
    const store = new PlanStore(dir);
    const p = store.create('被阻塞', ['a']);
    store.updateStep(p.id, p.steps[0].id, 'blocked', '等外部依赖');
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

describe('renderPlan', () => {
  it('distinguishes step states and shows progress', () => {
    const store = new PlanStore(dir);
    const p = store.create('渲染', ['做完的', '没做的'], '目标说明');
    store.updateStep(p.id, p.steps[0].id, 'done');
    const text = renderPlan(store.get(p.id)!);
    assert.ok(text.includes('渲染'), '应含标题');
    assert.ok(text.includes('目标说明'), '应含目标');
    assert.match(text, /1\/2/, `应显示 1/2 进度，实际: ${text.slice(0, 140)}`);

    const doneLine = text.split('\n').find((l) => l.includes('做完的'))!;
    const todoLine = text.split('\n').find((l) => l.includes('没做的'))!;
    assert.notEqual(doneLine.trim(), todoLine.trim(), '已完成与未完成的行必须可区分');
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
});
