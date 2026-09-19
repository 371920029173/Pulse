/**
 * Scheduled tasks.
 *
 * The behaviour worth testing is not "does a cron-like trigger fire" — that is
 * arithmetic. It is the boundary semantics, because those are what make a
 * scheduler safe to leave running:
 *
 *   - outside the window, a due task is DEFERRED and still runs later, never
 *     dropped
 *   - a window closing does NOT stop work in flight ("到点了不要硬拦截")
 *   - a soft limit REPORTS an overrun, it does not enforce it
 *   - an overnight window (22:00–06:00) is one continuous period, not an empty
 *     range that silently blocks everything
 *   - overlap protection actually prevents two agents touching the same files
 *
 * Time is injected, so nothing here waits on a real clock.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ScheduleStore, Scheduler, withinWindow, nextWindowStart, minutesUntilWindowEnd,
  validateTask, describeNextRun,
  type ScheduledTask, type WorkingWindow,
} from '../schedule.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-sched-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const store = () => new ScheduleStore(dir);

/** A local Date at a specific weekday/time. 2026-09-13 is a Sunday. */
function at(day: number, hour: number, minute = 0): Date {
  return new Date(2026, 8, 13 + day, hour, minute, 0, 0);
}

// ─── window arithmetic ───

describe('工作时间窗口', () => {
  it('窗口为 null 表示不限制', () => {
    assert.equal(withinWindow(at(1, 3), null), true);
    assert.equal(withinWindow(at(1, 3), undefined), true);
  });

  it('普通窗口（09:00–18:00）', () => {
    const w: WorkingWindow = { start: '09:00', end: '18:00' };
    assert.equal(withinWindow(at(1, 8, 59), w), false);
    assert.equal(withinWindow(at(1, 9, 0), w), true, '起始时刻应当算在内');
    assert.equal(withinWindow(at(1, 12), w), true);
    assert.equal(withinWindow(at(1, 17, 59), w), true);
    assert.equal(withinWindow(at(1, 18, 0), w), false, '结束时刻应当排除');
    assert.equal(withinWindow(at(1, 23), w), false);
  });

  it('跨夜窗口（22:00–06:00）是一段连续时间，不是空区间', () => {
    // `end < start` is the case a naive range check gets backwards, silently
    // blocking every run.
    const w: WorkingWindow = { start: '22:00', end: '06:00' };
    assert.equal(withinWindow(at(1, 23), w), true, '当天深夜应在窗口内');
    assert.equal(withinWindow(at(1, 2), w), true, '次日凌晨应在窗口内');
    assert.equal(withinWindow(at(1, 5, 59), w), true);
    assert.equal(withinWindow(at(1, 6, 0), w), false);
    assert.equal(withinWindow(at(1, 12), w), false, '中午不在窗口内');
    assert.equal(withinWindow(at(1, 21, 59), w), false);
  });

  it('限定星期几', () => {
    // 2026-09-14 is a Monday (getDay() === 1).
    const w: WorkingWindow = { start: '00:00', end: '23:59', days: [1, 3, 5] };
    assert.equal(withinWindow(at(1, 10), w), true, '周一应允许');
    assert.equal(withinWindow(at(2, 10), w), false, '周二应禁止');
    assert.equal(withinWindow(at(3, 10), w), true, '周三应允许');
  });

  it('起始等于结束时视为不限制（而不是永远关闭）', () => {
    assert.equal(withinWindow(at(1, 3), { start: '09:00', end: '09:00' }), true);
  });

  it('格式错误时视为不限制，而不是静默全禁', () => {
    // Blocking everything because a config string has a typo is the worst failure
    // mode: the feature looks broken with no explanation.
    assert.equal(withinWindow(at(1, 10), { start: 'oops', end: '18:00' }), true);
    assert.equal(withinWindow(at(1, 10), { start: '25:00', end: '18:00' }), true);
  });

  it('nextWindowStart 指向下一个开窗时刻', () => {
    const next = nextWindowStart(at(1, 7), { start: '09:00', end: '18:00' });
    assert.ok(next, '应当能算出下次开窗');
    assert.equal(next!.getHours(), 9);
    assert.equal(next!.getDate(), at(1, 7).getDate(), '同一天稍后开窗');
  });

  it('nextWindowStart 在窗口内时返回当前时刻', () => {
    const now = at(1, 12);
    assert.equal(nextWindowStart(now, { start: '09:00', end: '18:00' })?.getTime(), now.getTime());
  });

  it('nextWindowStart 跳过不允许的星期', () => {
    // Only Mondays; asked on a Monday after close, so the answer is next Monday.
    const next = nextWindowStart(at(1, 20), { start: '09:00', end: '18:00', days: [1] });
    assert.ok(next);
    assert.equal(next!.getDay(), 1, '应当落在周一');
    assert.ok(next!.getTime() > at(1, 20).getTime(), '必须在之后');
  });

  it('minutesUntilWindowEnd 处理跨夜', () => {
    // At 23:00, a 22:00–06:00 window has 7 hours left.
    assert.equal(minutesUntilWindowEnd(at(1, 23), { start: '22:00', end: '06:00' }), 7 * 60);
  });
});

// ─── validation ───

describe('任务校验', () => {
  const base = { name: 'x', prompt: 'do it' };

  it('接受合法的三种触发方式', () => {
    assert.doesNotThrow(() => validateTask({ ...base, trigger: { kind: 'daily', at: '09:30' } }));
    assert.doesNotThrow(() => validateTask({ ...base, trigger: { kind: 'interval', everyMinutes: 30 } }));
    assert.doesNotThrow(() => validateTask({ ...base, trigger: { kind: 'once', at: '2026-12-01T09:00:00Z' } }));
  });

  it('拒绝空名称或空指令', () => {
    assert.throws(() => validateTask({ prompt: 'x', trigger: { kind: 'daily', at: '09:00' } }), /名称/);
    assert.throws(() => validateTask({ name: 'x', trigger: { kind: 'daily', at: '09:00' } }), /指令/);
    assert.throws(() => validateTask({ name: '  ', prompt: '  ', trigger: { kind: 'daily', at: '09:00' } }), /名称/);
  });

  it('拒绝非法时间', () => {
    assert.throws(() => validateTask({ ...base, trigger: { kind: 'daily', at: '25:00' } }), /HH:MM/);
    assert.throws(() => validateTask({ ...base, trigger: { kind: 'daily', at: '9' } }), /HH:MM/);
    assert.throws(() => validateTask({ ...base, trigger: { kind: 'once', at: '不是时间' } }), /无效/);
  });

  it('拒绝非正数间隔', () => {
    assert.throws(() => validateTask({ ...base, trigger: { kind: 'interval', everyMinutes: 0 } }), /正数/);
    assert.throws(() => validateTask({ ...base, trigger: { kind: 'interval', everyMinutes: -5 } }), /正数/);
  });

  it('拒绝非法的任务窗口', () => {
    assert.throws(
      () => validateTask({ ...base, trigger: { kind: 'daily', at: '09:00' }, window: { start: 'x', end: '18:00' } }),
      /窗口/,
    );
  });
});

// ─── store ───

describe('任务存储', () => {
  it('创建、读取、更新、删除', () => {
    const s = store();
    const t = s.create({ name: '日报', prompt: '写日报', trigger: { kind: 'daily', at: '18:00' }, enabled: true, overlap: 'skip' });
    assert.ok(t.id);
    assert.equal(s.list().length, 1);
    assert.equal(s.get(t.id)?.name, '日报');

    s.update(t.id, { name: '周报' });
    assert.equal(s.get(t.id)?.name, '周报');

    assert.equal(s.remove(t.id), true);
    assert.equal(s.list().length, 0);
    assert.equal(s.remove(t.id), false, '重复删除应返回 false');
  });

  it('创建时拒绝非法输入', () => {
    const s = store();
    assert.throws(
      () => s.create({ name: '', prompt: 'x', trigger: { kind: 'daily', at: '09:00' }, enabled: true, overlap: 'skip' }),
      /名称/,
    );
  });

  it('更新时校验合并后的结果，而不是只看补丁', () => {
    const s = store();
    const t = s.create({ name: 'x', prompt: 'y', trigger: { kind: 'daily', at: '09:00' }, enabled: true, overlap: 'skip' });
    // The patch alone looks fine; combined with the existing fields it is not.
    assert.throws(() => s.update(t.id, { trigger: { kind: 'daily', at: '99:99' } }), /HH:MM/);
  });

  it('落盘后能重新读回', () => {
    const t = store().create({ name: '持久化', prompt: 'x', trigger: { kind: 'interval', everyMinutes: 15 }, enabled: true, overlap: 'skip' });
    const reloaded = store();
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.get(t.id)?.name, '持久化');
    assert.deepEqual(reloaded.get(t.id)?.trigger, { kind: 'interval', everyMinutes: 15 });
  });

  it('磁盘上损坏的条目被跳过，而不是让整个文件失效', () => {
    // One malformed entry must not cost the user their other tasks.
    const s = store();
    s.create({ name: '好的', prompt: 'x', trigger: { kind: 'daily', at: '09:00' }, enabled: true, overlap: 'skip' });
    const path = join(dir, '.she', 'schedule.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.tasks.push({ id: 'bad', name: '', prompt: '', trigger: { kind: 'daily', at: 'zz' } });
    writeFileSync(path, JSON.stringify(raw), 'utf8');

    const reloaded = store();
    assert.equal(reloaded.list().length, 1, '应当只保留可用的任务');
    assert.equal(reloaded.list()[0].name, '好的');
  });

  it('损坏的整个文件会留底，不会静默清空', () => {
    const path = join(dir, '.she', 'schedule.json');
    mkdirSync(join(dir, '.she'), { recursive: true });
    const broken = '{"schema_version":"she-schedule/1","tasks":[{"id":"a"';
    writeFileSync(path, broken, 'utf8');

    const s = store();
    assert.equal(s.list().length, 0);
    assert.ok(s.recoveryNotice, '应当报告恢复信息');
    assert.equal(readFileSync(s.recoveryNotice!.backup, 'utf8'), broken, '原文应当原样留底');
  });
});

// ─── scheduler ───

/** What a test hands the harness to create a task. */
type TaskSpec = Omit<ScheduledTask, 'id' | 'runCount' | 'createdAt' | 'updatedAt'> & { id: string };

/** Drives the scheduler with a controllable clock and controllable runs. */
function harness(specs: TaskSpec[] = []) {
  const s = store();
  for (const spec of specs) s.create(spec);

  let now = at(1, 12);
  let window: WorkingWindow | null = null;
  let failure: Error | null = null;
  let hold = false;
  /**
   * Resolvers for runs parked by `holdRuns`.
   *
   * A single "current resolver" slot is not enough: overwriting it drops the
   * earlier resolver and the run waits forever.
   */
  const waiters: Array<() => void> = [];
  const runs: string[] = [];

  const scheduler = new Scheduler({
    store: s,
    now: () => now,
    workingWindow: () => window,
    run: async (task) => {
      runs.push(task.id);
      if (hold) await new Promise<void>((resolve) => waiters.push(resolve));
      if (failure) throw failure;
    },
  });

  return {
    store: s,
    scheduler,
    runs,
    setNow: (d: Date) => { now = d; },
    setWindow: (w: WorkingWindow | null) => { window = w; },
    setFailure: (e: Error | null) => { failure = e; },
    /** Park subsequent runs until `releaseAll()`. */
    holdRuns: () => { hold = true; },
    releaseAll: () => {
      hold = false;
      for (const resolve of waiters.splice(0)) resolve();
    },
  };
}

const spec = (over: Partial<TaskSpec> & { id: string }): TaskSpec => ({
  name: over.id,
  prompt: 'x',
  enabled: true,
  overlap: 'skip',
  trigger: { kind: 'interval', everyMinutes: 1 },
  ...over,
} as TaskSpec);

const settle = () => new Promise((r) => setTimeout(r, 25));

describe('调度器', () => {
  it('不限制窗口时，到点即执行', async () => {
    const h = harness([spec({ id: 'j1' })]);
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['j1']);
  });

  it('停用的任务不执行', async () => {
    const h = harness([spec({ id: 'off', enabled: false })]);
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, []);
  });

  it('未到点的任务不执行', async () => {
    const h = harness([spec({ id: 'later', trigger: { kind: 'daily', at: '23:00' } })]);
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, []);
  });

  it('【关键】窗口外到点的任务被顺延，而不是丢弃', async () => {
    // The point of the feature: a job due at 02:00 with a 09:00–18:00 window must
    // still run, at 09:00 — not vanish silently.
    const h = harness([spec({ id: 'due' })]);
    h.setWindow({ start: '09:00', end: '18:00' });
    h.setNow(at(1, 2));

    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, [], '窗口外不应启动');
    const deferred = h.store.get('due')!;
    assert.equal(deferred.lastStatus, 'deferred', '应当记为顺延');
    assert.match(deferred.lastDeferredReason ?? '', /推迟到/, '应当说明推迟到何时');
    assert.equal(deferred.runCount, 0, '顺延不算执行过');

    // Open the window: the same task must now run.
    h.setNow(at(1, 9, 30));
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['due'], '开窗后必须执行，说明顺延不是丢弃');
  });

  it('【关键】窗口关闭不会中断正在执行的任务', async () => {
    const h = harness([spec({ id: 'running', softLimitMinutes: 1 })]);
    h.holdRuns();

    await h.scheduler.tick();
    await settle();
    assert.equal(h.runs.length, 1);
    assert.deepEqual(h.scheduler.running(), ['running'], '应当处于运行中');

    // Close the window AND blow past the soft limit while it runs.
    h.setWindow({ start: '09:00', end: '18:00' });
    h.setNow(at(1, 23));
    await h.scheduler.tick();
    await h.scheduler.tick();

    // It must still be running: a curfew that kills mid-edit work is worse than
    // an overrun.
    assert.deepEqual(h.scheduler.running(), ['running'], '运行中的任务不该被窗口关闭中断');
    h.releaseAll();
    await settle();
    assert.equal(h.store.get('running')?.lastStatus, 'ok', '释放后应当正常收尾');
  });

  it('软性时限超了只标记，不中断', async () => {
    const h = harness([spec({ id: 'slow', softLimitMinutes: 10 })]);
    h.holdRuns();

    await h.scheduler.tick();
    await settle();
    h.setNow(at(1, 13)); // an hour later, still running
    await h.scheduler.tick();

    assert.equal(h.store.get('slow')?.lastOverran, true, '应当标记超时');
    assert.deepEqual(h.scheduler.running(), ['slow'], '但仍然在跑');
    h.releaseAll();
    await settle();
  });

  it('运行中不会重复启动同一个任务', async () => {
    const h = harness([spec({ id: 'once-running' })]);
    h.holdRuns();
    await h.scheduler.tick();
    await settle();
    await h.scheduler.tick();
    await h.scheduler.tick();
    assert.equal(h.runs.length, 1, '同一个任务不应并行跑多份');
    h.releaseAll();
    await settle();
  });

  it('执行成功后记录耗时与计数', async () => {
    const h = harness([spec({ id: 'rec' })]);
    await h.scheduler.tick();
    await settle();
    const t = h.store.get('rec')!;
    assert.equal(t.lastStatus, 'ok');
    assert.equal(t.runCount, 1);
    assert.equal(t.running, false);
    assert.ok(typeof t.lastDurationMs === 'number');
    assert.ok(t.lastFinishedAt);
  });

  it('执行失败被记录，且不影响后续调度', async () => {
    const h = harness([spec({ id: 'boom' })]);
    h.setFailure(new Error('模型挂了'));
    await h.scheduler.tick();
    await settle();

    const t = h.store.get('boom')!;
    assert.equal(t.lastStatus, 'error');
    assert.match(t.lastError ?? '', /模型挂了/);
    // The run flag must be released on failure, or the task never runs again.
    assert.equal(t.running, false);

    h.setFailure(null);
    h.setNow(at(1, 13));
    await h.scheduler.tick();
    await settle();
    assert.equal(h.runs.length, 2, '失败后应当能再次执行');
  });

  it('一次性任务执行后自动停用', async () => {
    const h = harness([spec({ id: 'one', trigger: { kind: 'once', at: at(1, 11).toISOString() } })]);
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['one']);
    assert.equal(h.store.get('one')?.enabled, false, '一次性任务跑完应当停用');
  });

  it('一次性任务不会重复执行', async () => {
    const h = harness([spec({ id: 'one2', trigger: { kind: 'once', at: at(1, 11).toISOString() } })]);
    await h.scheduler.tick();
    await settle();
    // Even if it were re-enabled, runCount records that it already ran.
    h.store.update('one2', { enabled: true });
    await h.scheduler.tick();
    await settle();
    assert.equal(h.runs.length, 1);
  });

  it('每日任务同一天只跑一次', async () => {
    const h = harness([spec({ id: 'daily', trigger: { kind: 'daily', at: '12:00' } })]);
    await h.scheduler.tick();
    await settle();
    assert.equal(h.runs.length, 1);

    h.setNow(at(1, 12, 30)); // later the same day
    await h.scheduler.tick();
    await settle();
    assert.equal(h.runs.length, 1, '同一天不应重复执行');

    h.setNow(at(2, 12, 30)); // next day
    await h.scheduler.tick();
    await settle();
    assert.equal(h.runs.length, 2, '次日应再次执行');
  });

  it('间隔任务按上次执行时间计算', async () => {
    const h = harness([spec({ id: 'iv', trigger: { kind: 'interval', everyMinutes: 30 } })]);
    await h.scheduler.tick();
    await settle();
    assert.equal(h.runs.length, 1);

    h.setNow(at(1, 12, 10)); // only 10 minutes later
    await h.scheduler.tick();
    await settle();
    assert.equal(h.runs.length, 1, '间隔未到，不应执行');

    h.setNow(at(1, 12, 40));
    await h.scheduler.tick();
    await settle();
    assert.equal(h.runs.length, 2, '间隔已到，应当执行');
  });

  it('任务自己的窗口优先于全局窗口（用于单独放宽）', async () => {
    const h = harness([spec({ id: 'own', window: { start: '00:00', end: '23:59' } })]);
    h.setWindow({ start: '09:00', end: '18:00' });
    h.setNow(at(1, 3)); // outside the global window, inside its own
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['own'], '任务自己的窗口应当生效');
  });

  it('start/stop 可重复调用，不泄漏定时器', () => {
    const h = harness();
    h.scheduler.start();
    h.scheduler.stop();
    assert.doesNotThrow(() => h.scheduler.stop());
  });
});

describe('下次运行说明', () => {
  const task = (over: Partial<ScheduledTask>): ScheduledTask => ({
    id: 'x', name: 'x', prompt: 'p', enabled: true, overlap: 'skip',
    trigger: { kind: 'daily', at: '09:00' }, runCount: 0, createdAt: '', updatedAt: '', ...over,
  });

  it('停用时报「已停用」', () => {
    assert.equal(describeNextRun(task({ enabled: false }), null), '已停用');
  });

  it('窗口外到点时报「顺延至…」', () => {
    const t = task({ trigger: { kind: 'interval', everyMinutes: 1 } });
    assert.match(describeNextRun(t, { start: '09:00', end: '18:00' }, at(1, 3)), /顺延至/);
  });

  it('一次性任务跑完报「已完成」', () => {
    const t = task({ trigger: { kind: 'once', at: at(1, 11).toISOString() }, runCount: 1 });
    assert.equal(describeNextRun(t, null, at(2, 12)), '已完成');
  });

  it('每日任务报告时间', () => {
    assert.match(describeNextRun(task({}), null, at(1, 3)), /每天 09:00/);
  });
});
