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
  validateTask, describeNextRun, failureAlert, retryBackoffMs, MAX_AUTO_RETRIES,
  TaskNotRetryableError,
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

// ─── 失败重试与告警（第四轮 8b） ───

/*
 * 「失败」在列表里原来只有一档：`lastStatus: 'error'`。偶发一次（重试已经在排队）和一直失败
 * （重试已经放弃）看起来一模一样，而后者才是要用户动手的。这一段钉住两件事：失败后有界重试、
 * 以及这条区别被说出来。
 */
describe('失败重试与告警', () => {
  /*
   * 触发间隔取一天：初次必然到点（没有 lastStart 时 interval 视为到点），而失败之后它的触发器
   * 当天不会再到点 —— 所以第二次执行**只可能**来自重试。用「每天 23:00」之类的触发反而证明不了
   * 这一点：中午 12 点它压根不会跑第一次。
   */
  const SPARSE = { kind: 'interval', everyMinutes: 1440 } as const;

  it('退避随失败次数增长，超过表长按最后一档封顶', () => {
    assert.equal(retryBackoffMs(1), 60_000);
    assert.equal(retryBackoffMs(2), 300_000);
    assert.equal(retryBackoffMs(9), 300_000);
  });

  it('失败后排定重试，到点才真的再跑（触发器本身并不到点）', async () => {
    const h = harness([spec({ id: 'j1', trigger: SPARSE })]);
    h.setFailure(new Error('boom'));
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['j1']);

    const t1 = h.store.get('j1')!;
    assert.equal(t1.lastStatus, 'error');
    assert.equal(t1.consecutiveFailures, 1);
    assert.ok(t1.retryAt, '失败后应当排定重试');
    assert.equal(
      new Date(t1.retryAt!).getTime() - new Date(t1.lastFinishedAt!).getTime(),
      retryBackoffMs(1),
    );
    assert.match(failureAlert(t1)!, /已连续失败 1 次/);
    assert.match(failureAlert(t1)!, /自动重试/);
    assert.match(describeNextRun(t1, null, at(1, 12)), /自动重试/);

    // 差一秒：不该跑。触发器当天也不会到点，所以这一次执行只可能来自重试。
    h.setNow(new Date(new Date(t1.retryAt!).getTime() - 1000));
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['j1'], '重试未到点不应执行');

    h.setNow(new Date(new Date(t1.retryAt!).getTime() + 1000));
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['j1', 'j1'], '到点后应当自动重试');

    const t2 = h.store.get('j1')!;
    assert.equal(t2.consecutiveFailures, 2);
    assert.equal(
      new Date(t2.retryAt!).getTime() - new Date(t2.lastFinishedAt!).getTime(),
      retryBackoffMs(2),
      '第二次失败要用更长的退避，否则等于原地重试',
    );
  });

  it('连续失败超过上限后停止重试，并明确说是「停止」而不是「又失败了」', async () => {
    const h = harness([spec({ id: 'j1', trigger: SPARSE })]);
    h.setFailure(new Error('boom'));
    for (let i = 0; i <= MAX_AUTO_RETRIES; i++) {
      await h.scheduler.tick();
      await settle();
      const t = h.store.get('j1')!;
      if (t.retryAt) h.setNow(new Date(new Date(t.retryAt).getTime() + 1000));
    }
    const t = h.store.get('j1')!;
    assert.equal(t.consecutiveFailures, MAX_AUTO_RETRIES + 1);
    assert.equal(t.retryAt, undefined, '超过上限不应再留下待重试');
    assert.match(failureAlert(t)!, /已停止自动重试/);
    assert.equal(describeNextRun(t, null, at(1, 12)), '已停止自动重试（连续失败）');

    const before = h.runs.length;
    await h.scheduler.tick();
    await settle();
    assert.equal(h.runs.length, before, '停止后不应再自动执行');
  });

  it('成功一次就把连续失败清零，告警消失', async () => {
    const h = harness([spec({ id: 'j1', trigger: SPARSE })]);
    h.setFailure(new Error('boom'));
    await h.scheduler.tick();
    await settle();
    const t1 = h.store.get('j1')!;
    assert.equal(t1.consecutiveFailures, 1);

    h.setNow(new Date(new Date(t1.retryAt!).getTime() + 1000));
    h.setFailure(null);
    await h.scheduler.tick();
    await settle();
    const t2 = h.store.get('j1')!;
    assert.equal(t2.lastStatus, 'ok');
    assert.equal(t2.consecutiveFailures, undefined, '成功应当清零，否则告警永远挂着');
    assert.equal(t2.retryAt, undefined);
    assert.equal(failureAlert(t2), null);
  });

  it('重试不能绕过工作窗口：窗口外照样顺延', async () => {
    const h = harness([spec({ id: 'j1', trigger: SPARSE })]);
    h.setFailure(new Error('boom'));
    await h.scheduler.tick();
    await settle();
    const t1 = h.store.get('j1')!;

    h.setNow(new Date(new Date(t1.retryAt!).getTime() + 1000));
    h.setWindow({ start: '01:00', end: '02:00' }); // 12:01 不在其中
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['j1'], '窗口外的重试不应执行（否则重试成了后门）');
    assert.match(h.store.get('j1')!.lastDeferredReason ?? '', /顺延|时间段/);
  });

  it('一次性任务失败后停用，且不留下一个不会发生的重试', async () => {
    const h = harness([spec({ id: 'j1', trigger: { kind: 'once', at: at(1, 11).toISOString() } })]);
    h.setFailure(new Error('boom'));
    await h.scheduler.tick();
    await settle();
    const t = h.store.get('j1')!;
    assert.equal(t.enabled, false);
    assert.equal(t.retryAt, undefined);
    assert.equal(t.consecutiveFailures, 1);
    assert.match(failureAlert(t)!, /任务已停用/);
  });

  /*
   * 用户刚按了停止的任务不该被自动重开：那等于让 agent 去做它刚被叫停的事。区别只能由抛出的
   * 错误**类型**带过来（调度器读不到原因的语义），所以这里断言两件事：失败仍然被记录，重试没有。
   */
  it('调用方说「重试没用」时不排重试，但失败照记（用户按停止 / 撞了上限）', async () => {
    const h = harness([spec({ id: 'j1', trigger: SPARSE })]);
    h.setFailure(new TaskNotRetryableError('这一轮没有完成（aborted）：用户中止'));
    await h.scheduler.tick();
    await settle();

    const t = h.store.get('j1')!;
    assert.equal(t.lastStatus, 'error', '没跑成的任务不能记成 ok');
    assert.equal(t.consecutiveFailures, 1, '连败要计数，否则「一直失败」又看不见了');
    assert.match(t.lastError ?? '', /aborted/);
    assert.equal(t.retryAt, undefined, '明知重试没用就不该排重试');
    assert.doesNotMatch(failureAlert(t)!, /自动重试/);

    // 一小时后再 tick：重试（若排了，1 分钟后就该到点）会跑，而触发器离 24h 还差得远。
    h.setNow(at(1, 13));
    await h.scheduler.tick();
    await settle();
    assert.deepEqual(h.runs, ['j1'], '不排重试就不该有第二次自动执行');
  });

  it('普通的失败（比如接口连不上）仍然照排重试 —— 上一条不是「永远不重试」', async () => {
    const h = harness([spec({ id: 'j1', trigger: SPARSE })]);
    h.setFailure(new Error('这一轮没有完成（turn_failed）：连接被拒绝'));
    await h.scheduler.tick();
    await settle();
    assert.ok(h.store.get('j1')!.retryAt, '环境型失败要给重试机会');
  });

  it('连续失败与重试时刻会落盘，重启后仍然看得见', () => {
    const s = store();
    const t = s.create({
      name: 'x', prompt: 'p', trigger: { kind: 'daily', at: '09:00' }, enabled: true, overlap: 'skip',
    });
    s.recordRun(t.id, {
      consecutiveFailures: 2,
      retryAt: '2026-09-14T04:05:00.000Z',
      lastError: 'boom',
      lastStatus: 'error',
    });
    const reloaded = store();
    assert.equal(reloaded.get(t.id)?.consecutiveFailures, 2);
    assert.equal(reloaded.get(t.id)?.retryAt, '2026-09-14T04:05:00.000Z');
    assert.match(failureAlert(reloaded.get(t.id)!)!, /已连续失败 2 次/);
  });
});
