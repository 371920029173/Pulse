/**
 * Plan autopilot: a reply without tool calls mid-plan resumes the plan instead of ending the turn.
 * Regression for "automation is still turn-based": the agent stopped after every step to report.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planAutopilot, type Plan, type PlanStep } from '../plan-tools.js';

const now = Date.now();
const step = (id: string, status: PlanStep['status'], extra: Partial<PlanStep> = {}): PlanStep => ({
  id, title: 'step ' + id, status, dependsOn: [], onFailure: 'stop', attempts: 0, updatedAt: new Date(now).toISOString(), ...extra,
});
const plan = (steps: PlanStep[], extra: Partial<Plan> = {}): Plan => ({
  id: 'p1', title: '测试计划', status: 'open', steps, sessionId: 's1',
  createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), ...extra,
});
const opts = { turnStartedAt: now - 1000, reply: '第 1 步做完了，接下来做第 2 步。' };

describe('planAutopilot', () => {
  it('continues when runnable steps remain', () => {
    const d = planAutopilot(plan([step('s1', 'done'), step('s2', 'active'), step('s3', 'pending')]), opts);
    assert.equal(d.proceed, true);
    assert.ok(d.nudge?.includes('step s2'));
    assert.ok(d.nudge?.includes('2 步'));
  });

  it('stops when every step is done', () => {
    assert.equal(planAutopilot(plan([step('s1', 'done')]), opts).proceed, false);
  });

  it('never restarts a plan this turn did not touch', () => {
    const old = plan([step('s1', 'pending')], { updatedAt: new Date(now - 60_000).toISOString() });
    assert.equal(planAutopilot(old, opts).proceed, false);
  });

  it('hands back when a step is blocked with ask or stop', () => {
    const d = planAutopilot(plan([step('s1', 'blocked', { onFailure: 'ask' }), step('s2', 'pending')]), opts);
    assert.equal(d.proceed, false);
  });

  it('hands back when the reply asks the user a question', () => {
    const d = planAutopilot(plan([step('s1', 'active')]), { ...opts, reply: '要用哪个数据库？' });
    assert.equal(d.proceed, false);
  });

  it('does not continue into a step whose prerequisites are unfinished', () => {
    const d = planAutopilot(plan([step('s1', 'blocked', { onFailure: 'retry' }), step('s2', 'pending', { dependsOn: ['s1'] })]), opts);
    assert.equal(d.proceed, false);
  });

  it('signature changes only when a step status changes', () => {
    const a = planAutopilot(plan([step('s1', 'active'), step('s2', 'pending')]), opts).signature;
    const b = planAutopilot(plan([step('s1', 'done'), step('s2', 'active')]), opts).signature;
    assert.notEqual(a, b);
  });
});
