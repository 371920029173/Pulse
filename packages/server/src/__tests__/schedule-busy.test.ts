/**
 * A scheduled task whose conversation is busy is QUEUED, not failed.
 *
 * Regression: a task firing while the user was mid-turn threw "这一轮对话还在进行中" within
 * milliseconds, was recorded as an error, counted as a run, and a once-task disabled itself —
 * the reminder was simply lost. Now it waits and starts as soon as the turn ends.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduleStore, Scheduler, SessionBusyError, type ScheduledTask } from '../schedule.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-sched-busy-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Spec = Omit<ScheduledTask, 'id' | 'runCount' | 'createdAt' | 'updatedAt'> & { id: string };
const settle = () => new Promise((r) => setTimeout(r, 25));

function harness(spec: Spec, opts: { raceBusy?: boolean } = {}) {
  const store = new ScheduleStore(dir);
  store.create(spec);
  let busy = true;
  let raceOnce = !!opts.raceBusy;
  const runs: string[] = [];
  const scheduler = new Scheduler({
    store,
    now: () => new Date(2026, 8, 26, 12, 0),
    workingWindow: () => null,
    busyRetryMs: 0,
    busy: () => (busy && !opts.raceBusy ? '目标会话正在进行一轮对话' : null),
    run: async (task) => {
      if (raceOnce) { raceOnce = false; throw new SessionBusyError(); }
      runs.push(task.id);
    },
  });
  return { store, scheduler, runs, setBusy: (b: boolean) => { busy = b; } };
}

const once = (id: string): Spec => ({
  id, name: id, prompt: 'x', enabled: true, overlap: 'skip',
  trigger: { kind: 'once', at: new Date(2026, 8, 26, 11, 0).toISOString() },
});

describe('会话忙时的定时任务', () => {
  it('【关键】一次性任务撞上忙碌：排队而不是失败，也不会自我停用', async () => {
    const h = harness(once('remind'));
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, [], '忙时不应启动');
    const t = h.store.get('remind')!;
    assert.equal(t.lastStatus, 'deferred');
    assert.match(t.lastDeferredReason ?? '', /排队/);
    assert.equal(t.runCount, 0, '不应扣掉次数');
    assert.equal(t.enabled, true, '不应自我停用');
    assert.deepEqual(h.scheduler.waiting(), ['remind']);

    h.setBusy(false);
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['remind'], '空闲后必须执行');
    assert.equal(h.store.get('remind')!.runCount, 1);
    assert.equal(h.store.get('remind')!.enabled, false, '真正执行后才停用');
    assert.deepEqual(h.scheduler.waiting(), []);
  });

  it('检查与启动之间变忙（竞态）：撤销启动记账并排队', async () => {
    const h = harness({ ...once('race'), trigger: { kind: 'interval', everyMinutes: 60 } }, { raceBusy: true });
    await h.scheduler.tick();
    await settle();
    const t = h.store.get('race')!;
    assert.equal(t.runCount, 0);
    assert.equal(t.lastStartedAt, undefined, '间隔锚点不应被这次失败的启动推后');
    assert.equal(t.running, false);
    assert.deepEqual(h.scheduler.waiting(), ['race']);

    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['race']);
  });

  it('手动运行撞上忙碌：返回已排队，空闲后执行', async () => {
    const h = harness({ ...once('manual'), trigger: { kind: 'daily', at: '23:00' } });
    const r = await h.scheduler.runNow('manual');
    assert.equal(r.started, true);
    assert.match(r.reason ?? '', /排队/);
    h.setBusy(false);
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['manual'], '即使触发条件未到，排队的手动运行也要执行');
  });

  it('排队期间被停用的任务不再执行', async () => {
    const h = harness(once('dropped'));
    await h.scheduler.tick();
    h.store.update('dropped', { enabled: false });
    h.setBusy(false);
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, []);
    assert.deepEqual(h.scheduler.waiting(), []);
  });
});
describe('一次性任务：手动运行与清理', () => {
  it('【回归】手动运行不会吃掉一次性任务自己的触发（2099 探针跑两次后停用的问题）', async () => {
    const h = harness({ ...once('future'), trigger: { kind: 'once', at: '2099-01-01T00:00:00' } });
    h.setBusy(false);
    await h.scheduler.runNow('future');
    await settle();
    await h.scheduler.runNow('future');
    await settle();
    const t = h.store.get('future')!;
    assert.equal(t.runCount, 2);
    assert.equal(t.enabled, true, '手动运行后仍应保持启用，2099 那次还要跑');
    assert.equal(t.firedOnce, false);
  });

  it('到点真正触发后才停用', async () => {
    const h = harness(once('due'));
    h.setBusy(false);
    await h.scheduler.tick();
    await settle();
    const t = h.store.get('due')!;
    assert.equal(t.enabled, false);
    assert.equal(t.firedOnce, true);
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['due'], '不应再次触发');
  });

  it('完成超过 7 天的一次性任务会被清理，近期的和周期任务保留', () => {
    const store = new ScheduleStore(dir);
    const base = { prompt: 'x', overlap: 'skip' as const };
    store.create({ ...base, id: 'old', name: 'old', enabled: false, trigger: { kind: 'once', at: '2026-09-01T00:00:00' } });
    store.recordRun('old', { firedOnce: true, runCount: 1, lastFinishedAt: new Date(2026, 8, 10).toISOString() });
    store.create({ ...base, id: 'recent', name: 'recent', enabled: false, trigger: { kind: 'once', at: '2026-09-24T00:00:00' } });
    store.recordRun('recent', { firedOnce: true, runCount: 1, lastFinishedAt: new Date(2026, 8, 24).toISOString() });
    store.create({ ...base, id: 'iv', name: 'iv', enabled: false, trigger: { kind: 'interval', everyMinutes: 5 } });
    store.recordRun('iv', { runCount: 3, lastFinishedAt: new Date(2026, 8, 1).toISOString() });
    assert.equal(store.pruneFinished(new Date(2026, 8, 26)), 1);
    assert.deepEqual(store.list().map((t) => t.id).sort(), ['iv', 'recent']);
  });
});
