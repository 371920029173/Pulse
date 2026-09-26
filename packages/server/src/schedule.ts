/**
 * Scheduled work.
 *
 * Two separate ideas that are easy to conflate, and conflating them is what makes
 * schedulers destructive:
 *
 *   1. WHEN TO START. A task is due, and a working window says whether it may
 *      start now. Outside the window a due task is DEFERRED, not dropped: it runs
 *      at the next window opening. A nightly job whose window is 09:00–18:00 still
 *      runs, just at 09:00.
 *
 *   2. WHETHER TO STOP. Nothing here stops a run. A window closing, a soft time
 *      limit being exceeded, a restart — none of them abort work in flight. The
 *      requirement was explicit ("到点了不要硬拦截") and it is also the right
 *      behaviour: a task half-way through writing files is worse off killed than
 *      finished, and a schedule is a plan for starting, not a curfew.
 *
 * A soft limit still exists, as a REPORT. Overrunning runs are flagged so a
 * schedule that is too tight for its work is visible, rather than silently
 * producing overlapping runs.
 */
import { join } from 'node:path';
import { loadStateFile, saveStateFile } from './state-file.js';
import { createLogger } from '@she/shared';

const log = createLogger('schedule');

/** Current on-disk format. */
const SCHEMA = 'she-schedule/1';

/** A window during which new work may start. Times are LOCAL 'HH:MM'. */
export interface WorkingWindow {
  start: string;
  /** Exclusive. If <= `start`, the window wraps past midnight (e.g. 22:00→06:00). */
  end: string;
  /** Days of week, 0 = Sunday. Empty or absent = every day. */
  days?: number[];
}

export type ScheduleTrigger =
  /** Fires once at an absolute local time; disabled after it runs. */
  | { kind: 'once'; at: string }
  /** Fires every N minutes, measured from the last start. */
  | { kind: 'interval'; everyMinutes: number }
  /** Fires once per day at 'HH:MM' local time. */
  | { kind: 'daily'; at: string };

export type RunStatus = 'ok' | 'error' | 'deferred' | 'skipped' | 'running';

export interface ScheduledTask {
  id: string;
  name: string;
  /** Sent to the agent verbatim, as if the user had typed it. */
  prompt: string;
  /** Conversation to run in. Created on first run when absent. */
  sessionId?: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  /** Narrows the global window further. Null = inherit the global window. */
  window?: WorkingWindow | null;
  /**
   * What to do when the previous run has not finished.
   *
   * `skip` is the default because a schedule that silently piles up overlapping
   * runs is how you get two agents editing the same files.
   */
  overlap: 'skip' | 'queue';
  /** Report (never enforce) when a run exceeds this. */
  softLimitMinutes?: number;

  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastStatus?: RunStatus;
  lastError?: string;
  /** Why the last start was deferred, when it was. */
  lastDeferredReason?: string;
  /** How long the last run took, in ms. */
  lastDurationMs?: number;
  /** Set when the last run exceeded `softLimitMinutes`; cleared on the next run. */
  lastOverran?: boolean;
  /** True while a run is in flight. Not persisted across restarts, by design. */
  running?: boolean;
  runCount: number;
  /**
   * A `once` task's own trigger has fired. Separate from `runCount` because a manual
   * "run now" used to count as the fire: testing a task set for 2099 consumed it and
   * disabled it, so the real 2099 run would never have happened. Absent on old files,
   * where `runCount > 0` is the best available answer.
   */
  firedOnce?: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ScheduleFile {
  schema_version: string;
  tasks: ScheduledTask[];
}

/** Where a `once` trigger stands relative to `now`. */
function isDue(task: ScheduledTask, now: Date, lastStart: Date | null): boolean {
  const t = task.trigger;
  if (t.kind === 'once') {
    const at = new Date(t.at);
    if (Number.isNaN(at.getTime())) return false;
    return now.getTime() >= at.getTime() && !onceFired(task);
  }
  if (t.kind === 'interval') {
    if (!lastStart) return true;
    return now.getTime() - lastStart.getTime() >= t.everyMinutes * 60_000;
  }
  // daily
  const [h, m] = t.at.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const dueToday = new Date(now);
  dueToday.setHours(h, m, 0, 0);
  if (now.getTime() < dueToday.getTime()) return false;
  // Already ran today?
  if (lastStart && lastStart.toDateString() === now.toDateString() && lastStart.getTime() >= dueToday.getTime()) {
    return false;
  }
  return true;
}

/** Has a once-task's own trigger already fired? (Manual runs do not count.) */
function onceFired(task: ScheduledTask): boolean {
  return task.firedOnce ?? task.runCount > 0;
}

/** Finished one-shot tasks older than this are pruned from the list. */
export const FINISHED_ONCE_RETENTION_DAYS = 7;

/** Minutes since midnight for 'HH:MM', or null when malformed. */
function minutesOfDay(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Is `now` inside the window?
 *
 * Handles the overnight case, which is the one that matters for scheduled agent
 * work: a window of 22:00–06:00 is one continuous period, not an empty range
 * because `end < start`.
 */
export function withinWindow(now: Date, window: WorkingWindow | null | undefined): boolean {
  if (!window) return true;
  const start = minutesOfDay(window.start);
  const end = minutesOfDay(window.end);
  // A malformed window must not silently block everything; treat it as "no
  // restriction" and let validation surface the problem instead.
  if (start === null || end === null) return true;

  if (window.days && window.days.length > 0) {
    if (!window.days.includes(now.getDay())) return false;
  }

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true; // a zero-length window means "any time"
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  // Wraps midnight: open from `start` to 24:00, and from 00:00 to `end`.
  return nowMinutes >= start || nowMinutes < end;
}

/** The next moment the window opens at or after `now`. Null when always open. */
export function nextWindowStart(now: Date, window: WorkingWindow | null | undefined): Date | null {
  if (withinWindow(now, window)) return now;
  if (!window) return null;
  const start = minutesOfDay(window.start);
  if (start === null) return null;

  // Try each of the next 8 days; the first day whose start is in the future AND
  // whose day is allowed is the answer.
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const candidate = new Date(now);
    candidate.setDate(candidate.getDate() + dayOffset);
    candidate.setHours(Math.floor(start / 60), start % 60, 0, 0);
    if (candidate.getTime() <= now.getTime()) continue;
    if (window.days && window.days.length > 0 && !window.days.includes(candidate.getDay())) continue;
    return candidate;
  }
  return null;
}

/** How many minutes until the window closes, or null when it will not soon. */
export function minutesUntilWindowEnd(now: Date, window: WorkingWindow | null | undefined): number | null {
  if (!window) return null;
  const end = minutesOfDay(window.end);
  if (end === null) return null;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (end > nowMinutes) return end - nowMinutes;
  // Window wraps, so the end is tomorrow.
  return 24 * 60 - nowMinutes + end;
}

/** Validate a task before it is stored. Throws with a human-readable reason. */
export function validateTask(task: Partial<ScheduledTask>): void {
  if (!task.name || !String(task.name).trim()) throw new Error('任务需要一个名称');
  if (!task.prompt || !String(task.prompt).trim()) throw new Error('任务需要一段要执行的指令');
  const t = task.trigger;
  if (!t) throw new Error('任务需要触发方式');
  if (t.kind === 'once') {
    if (!t.at || Number.isNaN(new Date(t.at).getTime())) throw new Error(`一次性任务的时间无效: ${t.at}`);
  } else if (t.kind === 'interval') {
    const n = Number(t.everyMinutes);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`间隔必须是正数分钟: ${t.everyMinutes}`);
    if (n < 1) throw new Error('间隔不能小于 1 分钟');
  } else if (t.kind === 'daily') {
    if (minutesOfDay(t.at) === null) throw new Error(`每日时间格式应为 HH:MM: ${t.at}`);
  } else {
    throw new Error(`未知的触发方式`);
  }
  if (task.window) {
    if (minutesOfDay(task.window.start) === null) throw new Error(`窗口开始时间格式应为 HH:MM: ${task.window.start}`);
    if (minutesOfDay(task.window.end) === null) throw new Error(`窗口结束时间格式应为 HH:MM: ${task.window.end}`);
  }
  if (task.softLimitMinutes !== undefined && task.softLimitMinutes !== null) {
    const n = Number(task.softLimitMinutes);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`软性时限必须是正数分钟`);
  }
}

/** Normalise anything loaded from disk into a usable task list. */
function normalizeScheduleFile(raw: ScheduleFile): ScheduleFile {
  if (!raw || typeof raw !== 'object') throw new Error('不是对象');
  if (!Array.isArray(raw.tasks)) throw new Error('tasks 不是数组');

  const tasks: ScheduledTask[] = [];
  for (const entry of raw.tasks) {
    if (!entry || typeof entry !== 'object') continue;
    const t = entry as Partial<ScheduledTask>;
    if (typeof t.id !== 'string' || !t.id) continue;
    // A task that got mangled on disk should not take the whole file down with it.
    try {
      validateTask(t);
    } catch (err) {
      log.warn(`跳过无法使用的定时任务 ${t.id ?? '(无 id)'}: ${(err as Error).message}`);
      continue;
    }
    tasks.push({
      id: t.id,
      name: String(t.name),
      prompt: String(t.prompt),
      sessionId: typeof t.sessionId === 'string' ? t.sessionId : undefined,
      enabled: t.enabled !== false,
      trigger: t.trigger as ScheduleTrigger,
      window: t.window ?? null,
      overlap: t.overlap === 'queue' ? 'queue' : 'skip',
      softLimitMinutes: t.softLimitMinutes,
      lastStartedAt: t.lastStartedAt,
      lastFinishedAt: t.lastFinishedAt,
      lastStatus: t.lastStatus,
      lastError: t.lastError,
      lastDeferredReason: t.lastDeferredReason,
      lastDurationMs: t.lastDurationMs,
      lastOverran: t.lastOverran,
      runCount: Number.isFinite(t.runCount) ? Number(t.runCount) : 0,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date().toISOString(),
    });
  }
  return { schema_version: SCHEMA, tasks };
}

/** Persistent task list. */
export class ScheduleStore {
  private readonly path: string;
  private data: ScheduleFile;
  private recovery: { backup: string; reason: string } | null = null;

  constructor(baseDir: string) {
    this.path = join(baseDir, '.she', 'schedule.json');
    const outcome = loadStateFile<ScheduleFile>({
      path: this.path,
      version: SCHEMA,
      empty: () => ({ schema_version: SCHEMA, tasks: [] }),
      parse: (raw) => normalizeScheduleFile(raw as ScheduleFile),
      migrations: { '*': (raw) => ({ ...raw, schema_version: SCHEMA }) },
    });
    this.data = outcome.data;
    if (outcome.recovered) {
      this.recovery = outcome.recovered;
      log.error(`定时任务文件无法读取，已保留为备份。原因: ${outcome.recovered.reason}；备份: ${outcome.recovered.backup}`);
      this.persist();
    }
    this.persist();
  }

  get recoveryNotice(): { backup: string; reason: string } | null {
    return this.recovery;
  }

  list(): ScheduledTask[] {
    return this.data.tasks.map((t) => ({ ...t }));
  }

  get(id: string): ScheduledTask | undefined {
    const t = this.data.tasks.find((x) => x.id === id);
    return t ? { ...t } : undefined;
  }

  /** The live object, for the scheduler to mutate + persist. */
  private ref(id: string): ScheduledTask | undefined {
    return this.data.tasks.find((x) => x.id === id);
  }

  create(input: Omit<ScheduledTask, 'id' | 'runCount' | 'createdAt' | 'updatedAt'> & { id?: string }): ScheduledTask {
    validateTask(input);
    const now = new Date().toISOString();
    const task: ScheduledTask = {
      ...input,
      id: input.id && !this.ref(input.id) ? input.id : `job_${randomId()}`,
      enabled: input.enabled !== false,
      overlap: input.overlap === 'queue' ? 'queue' : 'skip',
      window: input.window ?? null,
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.data.tasks.push(task);
    this.persist();
    return { ...task };
  }

  update(id: string, patch: Partial<ScheduledTask>): ScheduledTask | null {
    const task = this.ref(id);
    if (!task) return null;
    // Validate the RESULT, not the patch: changing only `trigger` must still be
    // checked against the fields it depends on.
    const merged = { ...task, ...patch, id: task.id } as ScheduledTask;
    validateTask(merged);
    Object.assign(task, patch, { id: task.id, updatedAt: new Date().toISOString() });
    this.persist();
    return { ...task };
  }

  remove(id: string): boolean {
    const before = this.data.tasks.length;
    this.data.tasks = this.data.tasks.filter((t) => t.id !== id);
    if (this.data.tasks.length === before) return false;
    this.persist();
    return true;
  }

  /**
   * Drop one-shot tasks that fired, are disabled, and finished more than `days` ago.
   * Without this every probe and reminder stayed in the list forever. Returns the count.
   */
  pruneFinished(now: Date, days = FINISHED_ONCE_RETENTION_DAYS): number {
    const cutoff = now.getTime() - days * 86_400_000;
    const before = this.data.tasks.length;
    this.data.tasks = this.data.tasks.filter((t) => {
      if (t.trigger.kind !== 'once' || t.enabled || t.running || !onceFired(t)) return true;
      const finished = t.lastFinishedAt ? new Date(t.lastFinishedAt).getTime() : NaN;
      return !(Number.isFinite(finished) && finished < cutoff);
    });
    const removed = before - this.data.tasks.length;
    if (removed > 0) this.persist();
    return removed;
  }

  /** Record the outcome of a run. Called by the scheduler. */
  recordRun(id: string, patch: Partial<ScheduledTask>): void {
    const task = this.ref(id);
    if (!task) return;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.persist();
  }

  private persist(): void {
    saveStateFile(this.path, this.data);
  }
}

/** Short, URL-safe id. Collision-resistant enough for a handful of tasks. */
function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ─── Scheduler ───

/**
 * The conversation a task writes into is in the middle of a turn.
 *
 * Not a failure of the task. It used to be treated as one: the run threw within milliseconds
 * ("这一轮对话还在进行中"), was recorded as an error, counted as a run, and a `once` task
 * then disabled itself — so a reminder that happened to fire while the user was chatting was
 * silently lost. The runner throws this instead, and the scheduler queues the task and starts
 * it as soon as the conversation is free, without spending the run.
 */
export class SessionBusyError extends Error {
  constructor(message = '目标会话正在进行一轮对话') {
    super(message);
    this.name = 'SessionBusyError';
  }
}

/** How often a queued (busy-deferred) task re-checks whether its conversation is free. */
const BUSY_RETRY_MS = 3_000;

export interface SchedulerDeps {
  store: ScheduleStore;
  /** Runs one task's prompt. Provided by the server so this stays testable. */
  run: (task: ScheduledTask) => Promise<void>;
  /** Global window. `null` means no restriction. */
  workingWindow: () => WorkingWindow | null;
  /**
   * Why the task's conversation cannot take a turn right now, or null when it can.
   * Checked before a start so a busy conversation queues the task instead of failing it.
   */
  busy?: (task: ScheduledTask) => string | null;
  /** Injectable clock, so the tests do not have to wait for real time. */
  now?: () => Date;
  /** Delay before a queued task re-checks; injectable for tests. 0 disables the fast retry. */
  busyRetryMs?: number;
  tickSeconds?: number;
}

/** Ticks and dispatches due tasks. */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly now: () => Date;
  private readonly tickSeconds: number;
  /** Tasks whose run has not finished yet. */
  private readonly inFlight = new Set<string>();
  /**
   * Tasks that came due (or were started by hand) while their conversation was busy.
   * They run as soon as it is free, whether or not their trigger is still "due" by then —
   * an interval or manual run must not be lost just because the busy turn outlasted it.
   */
  private readonly queued = new Set<string>();
  /** Queued tasks that were started by hand, so the eventual run is still a manual one. */
  private readonly queuedManual = new Set<string>();
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.tickSeconds = Math.max(5, deps.tickSeconds ?? 30);
  }

  start(): void {
    if (this.timer) return;
    // `unref` so a scheduler never keeps the process alive on its own.
    this.timer = setInterval(() => { void this.tick(); }, this.tickSeconds * 1000);
    this.timer.unref?.();
    log.info(`调度器已启动（每 ${this.tickSeconds}s 检查一次）`);
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  /** Tasks waiting for their conversation to become free. */
  waiting(): string[] {
    return [...this.queued];
  }

  /** Queue a task behind the running turn and arrange a prompt re-check. */
  private queueBusy(task: ScheduledTask, reason: string): void {
    const first = !this.queued.has(task.id);
    this.queued.add(task.id);
    this.deps.store.recordRun(task.id, {
      lastStatus: 'deferred',
      lastDeferredReason: `${reason}，已排队，本轮结束后自动执行`,
    });
    if (first) log.info(`任务「${task.name}」已排队：${reason}`);
    const delay = this.deps.busyRetryMs ?? BUSY_RETRY_MS;
    if (delay > 0 && !this.retryTimer) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.tick(); }, delay);
      this.retryTimer.unref?.();
    }
  }

  /** Tasks currently running. */
  running(): string[] {
    return [...this.inFlight];
  }

  /**
   * Run a task immediately, outside its trigger.
   *
   * The window is NOT checked here — the caller has already decided this start is
   * allowed (the HTTP route rejects it when outside the window, with a message
   * explaining that it is a deferral rather than a refusal).
   *
   * Routed through the same bookkeeping as a scheduled run so a manual execution
   * is recorded exactly like an automatic one. The first version of the route
   * called the runner directly and left `lastStatus` unset, which made a manual
   * run invisible in the list — indistinguishable from never having run.
   */
  async runNow(id: string): Promise<{ started: boolean; reason?: string }> {
    const task = this.deps.store.get(id);
    if (!task) return { started: false, reason: '任务不存在' };
    if (this.inFlight.has(id)) return { started: false, reason: '该任务正在执行' };
    const busy = this.deps.busy?.(task);
    if (busy) {
      this.queueBusy(task, busy);
      this.queuedManual.add(id);
      return { started: true, reason: `${busy}，已排队，本轮结束后自动执行` };
    }
    // Deliberately not awaited: the caller is an HTTP route that should return
    // promptly, and the run can take minutes.
    void this.runTask(task, true);
    return { started: true };
  }

  /**
   * One scheduling pass.
   *
   * Public and callable directly so tests can drive it deterministically instead
   * of waiting on a timer.
   */
  async tick(): Promise<void> {
    // A slow run must not overlap the next tick; the in-flight set alone is not
    // enough because a tick can await several starts.
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const pruned = this.deps.store.pruneFinished(now);
      if (pruned > 0) log.info(`已清理 ${pruned} 个完成超过 ${FINISHED_ONCE_RETENTION_DAYS} 天的一次性任务`);
      for (const task of this.deps.store.list()) {
        if (!task.enabled) continue;
        if (this.inFlight.has(task.id)) {
          this.checkOverrun(task);
          continue;
        }
        if (task.overlap === 'skip' && task.running) continue;

        const wasQueued = this.queued.has(task.id);
        const lastStart = task.lastStartedAt ? new Date(task.lastStartedAt) : null;
        if (!wasQueued && !isDue(task, now, lastStart)) continue;

        // Window check happens only at START time, and a blocked start is
        // deferred rather than lost.
        const window = this.windowFor(task);
        if (!withinWindow(now, window)) {
          const next = nextWindowStart(now, window);
          const reason = next
            ? `当前不在允许工作的时间段内，推迟到 ${next.toLocaleString()}`
            : '当前不在允许工作的时间段内';
          this.deps.store.recordRun(task.id, { lastStatus: 'deferred', lastDeferredReason: reason });
          log.info(`任务「${task.name}」已顺延：${reason}`);
          continue;
        }

        const busy = this.deps.busy?.(task);
        if (busy) {
          this.queueBusy(task, busy);
          continue;
        }

        const manual = this.queuedManual.delete(task.id);
        this.queued.delete(task.id);
        void this.runTask(task, manual);
      }
      // A queued task that was disabled or deleted meanwhile must not linger.
      for (const id of [...this.queued]) {
        const t = this.deps.store.get(id);
        if (!t || !t.enabled) { this.queued.delete(id); this.queuedManual.delete(id); }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** The window that applies to a task: its own, narrowed by the global one. */
  private windowFor(task: ScheduledTask): WorkingWindow | null {
    const global = this.deps.workingWindow();
    if (task.window) return task.window;
    return global;
  }

  private async runTask(task: ScheduledTask, manual = false): Promise<void> {
    this.inFlight.add(task.id);
    const previousStart = this.deps.store.get(task.id)?.lastStartedAt;
    const startedAt = this.now();
    this.deps.store.recordRun(task.id, {
      lastStatus: 'running',
      running: true,
      lastStartedAt: startedAt.toISOString(),
      lastDeferredReason: undefined,
      lastOverran: false,
    });
    log.info(`开始执行定时任务「${task.name}」`);

    let error: string | undefined;
    let requeued = false;
    try {
      await this.deps.run(task);
    } catch (err) {
      if (err instanceof SessionBusyError) {
        /*
         * Lost the race: the conversation became busy between the check and the start.
         * Undo the start bookkeeping so nothing is spent — no run counted, a once-task stays
         * enabled, and an interval keeps its old anchor — then queue it like any busy task.
         */
        this.inFlight.delete(task.id);
        this.deps.store.recordRun(task.id, { running: false, lastStartedAt: previousStart });
        this.queueBusy(task, err.message);
        requeued = true;
      }
      error = (err as Error).message;
    } finally {
      // The busy path above already undid the start; nothing was spent.
      if (!requeued) {
      const finishedAt = this.now();
      const durationMs = finishedAt.getTime() - startedAt.getTime();
      const limitMs = task.softLimitMinutes ? task.softLimitMinutes * 60_000 : null;
      const overran = limitMs !== null && durationMs > limitMs;
      this.inFlight.delete(task.id);
      this.deps.store.recordRun(task.id, {
        lastStatus: error ? 'error' : 'ok',
        running: false,
        lastFinishedAt: finishedAt.toISOString(),
        lastDurationMs: durationMs,
        lastError: error,
        lastOverran: overran,
        runCount: (this.deps.store.get(task.id)?.runCount ?? 0) + 1,
        // A once-task disables itself after its OWN trigger fired. A manual run leaves the
        // scheduled fire intact (and pins `firedOnce` so the bumped runCount is not misread).
        ...(task.trigger.kind === 'once'
          ? (manual ? { firedOnce: onceFired(task) } : { enabled: false, firedOnce: true })
          : {}),
      });

      /*
       * Reported, never enforced. Stopping a run because it "should" have finished
       * is how you get half-written files: the agent is mid-edit and has no way to
       * know it was cut off. Flagging it lets the schedule be fixed instead.
       */
      if (overran) {
        log.warn(
          `任务「${task.name}」超出软性时限：跑了 ${Math.round(durationMs / 60_000)} 分钟，`
          + `设定 ${task.softLimitMinutes} 分钟。未中断——请调宽时限或简化任务。`,
        );
      }
      if (error) log.warn(`任务「${task.name}」失败: ${error}`);
      else log.info(`任务「${task.name}」完成，用时 ${Math.round(durationMs / 1000)}s`);
      }
    }
  }

  /** Flag a run that has passed its soft limit while still going. */
  private checkOverrun(task: ScheduledTask): void {
    if (!task.softLimitMinutes || !task.lastStartedAt || task.lastOverran) return;
    const elapsed = this.now().getTime() - new Date(task.lastStartedAt).getTime();
    if (elapsed > task.softLimitMinutes * 60_000) {
      this.deps.store.recordRun(task.id, { lastOverran: true, lastStatus: 'running' });
      log.warn(`任务「${task.name}」已超出软性时限但仍在运行（不会中断）`);
    }
  }
}

/** A human-readable summary of when a task next becomes eligible to start. */
export function describeNextRun(task: ScheduledTask, window: WorkingWindow | null, now = new Date()): string {
  if (!task.enabled) return '已停用';
  const lastStart = task.lastStartedAt ? new Date(task.lastStartedAt) : null;
  if (isDue(task, now, lastStart)) {
    if (withinWindow(now, window)) return '即将执行';
    const next = nextWindowStart(now, window);
    return next ? `顺延至 ${next.toLocaleString()}` : '等待允许的时间段';
  }
  const t = task.trigger;
  if (t.kind === 'once') {
    return onceFired(task) ? '已完成' : `等待 ${new Date(t.at).toLocaleString()}`;
  }
  if (t.kind === 'interval') {
    if (!lastStart) return `每 ${t.everyMinutes} 分钟（将尽快执行）`;
    const next = new Date(lastStart.getTime() + t.everyMinutes * 60_000);
    return `下次约 ${next.toLocaleTimeString()}`;
  }
  return `每天 ${t.at}`;
}
