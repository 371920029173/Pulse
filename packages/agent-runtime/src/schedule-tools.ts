/**
 * Scheduling tools, so the agent can plan its own future work.
 *
 * "Remind me tomorrow", "run this check every morning", "hold off until the quiet
 * hours" are things a user says to an assistant, not things they configure in a
 * settings panel. Without these tools the agent can only say it would have to be
 * set up manually.
 *
 * The store lives in the server (the scheduler owns it and both must see the same
 * tasks), so this module takes a narrow bridge rather than the store itself. That
 * keeps agent-runtime free of a dependency on the server package and keeps the
 * surface the agent can touch explicit.
 */
import type { ToolDefinition } from '@she/shared';

/** A task as the agent sees it. Deliberately smaller than the stored record. */
export interface ScheduledTaskView {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  /** Human-readable trigger, e.g. "每天 09:00" or "每 30 分钟". */
  when: string;
  /** Why it has not started yet, when it was deferred. */
  deferredReason?: string;
  /** When it will next be eligible to start. */
  nextRun?: string;
  lastStatus?: string;
  lastError?: string;
  runCount: number;
}

/** The working window, as reported to the agent. */
export interface WindowView {
  start: string;
  end: string;
  days?: number[];
}

/**
 * What the scheduling tools need from the server.
 *
 * Narrow on purpose: every method here is something the agent can reach through a
 * tool, so adding to it widens what the model can do to the user's schedule.
 */
export interface ScheduleBridge {
  list(): ScheduledTaskView[];
  create(input: {
    name: string;
    prompt: string;
    trigger: Record<string, unknown>;
    /**
     * Conversation the result belongs in.
     *
     * Threaded through from the tool call, because the tool tells the user the
     * output will appear in the chat they asked from — a promise the first
     * implementation did not keep, since nothing passed this along and every task
     * silently ran in a fresh session.
     */
    sessionId?: string | null;
    enabled?: boolean;
    window?: WindowView | null;
    overlap?: 'skip' | 'queue';
    softLimitMinutes?: number;
  }): ScheduledTaskView;
  remove(id: string): boolean;
  /** Current working window, or null when unrestricted. */
  window(): WindowView | null;
  /** Whether new work may start right now. */
  withinWindow(): boolean;
  /** ISO timestamp of the next window opening, when currently outside it. */
  nextWindowStart(): string | null;
}

export interface ToolResult { ok: boolean; output: string; }

function text(output: string, ok = true): ToolResult {
  return { ok, output };
}

/** Minutes since midnight for 'HH:MM', or null when malformed OR out of range. */
function parseHhMm(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  // Range-check explicitly. The regex alone accepts "99:99", and `setHours(99, 99)`
  // rolls over silently — producing a task that is scheduled for a time that never
  // arrives, with no error to explain why it never ran.
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Parse the `when` a model supplies into a trigger. */
function parseTrigger(args: Record<string, unknown>):
  | { ok: true; trigger: Record<string, unknown>; when: string }
  | { ok: false; error: string } {
  const kind = String(args.kind ?? '').trim();
  const HHMM_HINT = '时间格式应为 HH:MM（例如 09:30），且小时 0–23、分钟 0–59';

  if (kind === 'once') {
    const atRaw = args.at;
    if (typeof atRaw !== 'string' || !atRaw.trim()) {
      return { ok: false, error: 'once 需要 at（ISO 时间，或今天的 HH:MM）' };
    }
    // Accept a bare local time for today/tomorrow, because a model asked to
    // "remind me at 9" should not have to do date arithmetic first.
    if (/^\d{1,2}:\d{2}$/.test(atRaw.trim())) {
      const minutes = parseHhMm(atRaw);
      if (minutes === null) return { ok: false, error: `${HHMM_HINT}，收到的是 ${atRaw}` };
      const d = new Date();
      d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      return { ok: true, trigger: { kind: 'once', at: d.toISOString() }, when: `一次性 ${d.toLocaleString()}` };
    }
    const parsed = new Date(atRaw);
    if (Number.isNaN(parsed.getTime())) return { ok: false, error: `无法识别的时间: ${atRaw}` };
    return { ok: true, trigger: { kind: 'once', at: parsed.toISOString() }, when: `一次性 ${parsed.toLocaleString()}` };
  }

  if (kind === 'daily') {
    const at = args.at;
    if (typeof at !== 'string' || parseHhMm(at) === null) {
      return { ok: false, error: `daily 需要 at，${HHMM_HINT}；收到的是 ${String(args.at ?? '(空)')}` };
    }
    return { ok: true, trigger: { kind: 'daily', at: at.trim() }, when: `每天 ${at.trim()}` };
  }

  if (kind === 'interval') {
    const n = Number(args.everyMinutes);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'interval 需要正的 everyMinutes（分钟数）' };
    return { ok: true, trigger: { kind: 'interval', everyMinutes: n }, when: `每 ${n} 分钟` };
  }

  return { ok: false, error: 'kind 必须是 once / daily / interval 之一' };
}

/**
 * Build the scheduling tools.
 *
 * `sessionId` is captured so a task created from a conversation runs in that
 * conversation — the agent's output lands where the user will look for it.
 */
export function makeScheduleTools(bridge: ScheduleBridge, sessionId: string | null): ToolDefinition[] {
  return [
    {
      name: 'schedule_create',
      description:
        '安排一件将来的工作（定时任务）。当用户说"明天提醒我"、"每天早上检查一下"、"半小时后再试"时用它，'
        + '而不是回答"请你手动设置"。任务会自动在到点时执行，并把结果写回当前会话。'
        + '注意：如果设置了允许工作的时间段，到点但不在时间段内会自动顺延到下一个时间段，不会被丢弃。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名称，简短，例如「每日构建检查」' },
          prompt: { type: 'string', description: '到点时要执行的指令，写得像你对我说的一句话。可以是多步任务。' },
          kind: {
            type: 'string',
            enum: ['once', 'daily', 'interval'],
            description: 'once=只执行一次；daily=每天固定时间；interval=每隔一段时间',
          },
          at: { type: 'string', description: 'once 用 ISO 时间或 HH:MM；daily 用 HH:MM' },
          everyMinutes: { type: 'number', description: 'interval 的间隔分钟数' },
          softLimitMinutes: {
            type: 'number',
            description: '可选。预计需要多久。超时只会被记录提示，不会中断任务。',
          },
        },
        required: ['name', 'prompt', 'kind'],
      },
    },
    {
      name: 'schedule_list',
      description: '查看已经安排的定时任务（含下次运行时间、是否被顺延、上次结果）。已经跑完的一次性任务默认只计数不列出，includeFinished=true 可见；它们在完成 7 天后自动清理。',
      parameters: {
        type: 'object',
        properties: { includeFinished: { type: 'boolean', description: '同时列出已跑完的一次性任务（默认 false）' } },
        required: [],
      },
    },
    {
      name: 'schedule_cancel',
      description: '取消一个定时任务。需要提供任务 id（先用 schedule_list 查到）。正在执行的任务无法取消。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '任务 id' } },
        required: ['id'],
      },
    },
    {
      name: 'schedule_window',
      description:
        '查看或设置「允许工作的时间段」。设了这个时间段后，到点但不在时间段内的任务会顺延到下次开窗，'
        + '已经开跑的绝不会被中断。传 start 和 end 表示设置；不传参数表示查看。'
        + '支持跨夜（例如 22:00 到 06:00）。',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: '开始时间 HH:MM，例如 09:00' },
          end: { type: 'string', description: '结束时间 HH:MM，例如 18:00' },
          days: {
            type: 'array',
            items: { type: 'number' },
            description: '可选。允许的星期几，0=周日。不传表示每天。',
          },
          clear: { type: 'boolean', description: '设为 true 表示取消时间段限制（全天允许）' },
        },
        required: [],
      },
    },
  ];
}

/**
 * Execute a scheduling tool call. Returns null when the name is not ours.
 *
 * `setWindow` is injected because the window lives in config, which agent-runtime
 * does not own.
 */
export async function executeScheduleTool(
  name: string,
  args: Record<string, unknown>,
  bridge: ScheduleBridge,
  sessionId: string | null,
  setWindow: (w: WindowView | null) => Promise<void> | void,
): Promise<ToolResult | null> {
  if (!name.startsWith('schedule_')) return null;

  try {
    switch (name) {
      case 'schedule_create': {
        const nameArg = String(args.name ?? '').trim();
        const prompt = String(args.prompt ?? '').trim();
        if (!nameArg) return text('schedule_create 失败: 缺少 name', false);
        if (!prompt) return text('schedule_create 失败: 缺少 prompt', false);

        const parsed = parseTrigger(args);
        if (!parsed.ok) return text(`schedule_create 失败: ${parsed.error}`, false);

        const softLimit = Number(args.softLimitMinutes);
        const task = bridge.create({
          name: nameArg,
          prompt,
          trigger: parsed.trigger,
          // Remembered so the run lands in the conversation the user is looking at.
          sessionId,
          enabled: true,
          overlap: 'skip',
          ...(Number.isFinite(softLimit) && softLimit > 0 ? { softLimitMinutes: softLimit } : {}),
        });

        // Say where it will run, and whether the window may defer it — otherwise
        // the user expects output at a time it will not arrive.
        const parts = [`已安排定时任务「${task.name}」（${task.when}），id=${task.id}`];
        parts.push(sessionId
          ? '执行时结果会写回当前会话。'
          : '这个任务还没有归属会话，首次执行时会新建一个会话并写在那里。');
        if (!bridge.withinWindow()) {
          const next = bridge.nextWindowStart();
          parts.push(
            `注意：当前不在允许工作的时间段内，到点后会顺延${next ? `到 ${new Date(next).toLocaleString()}` : ''}，不会丢任务。`,
          );
        }
        return text(parts.join('\n'));
      }

      case 'schedule_list': {
        const all = bridge.list();
        if (all.length === 0) return text('目前没有安排任何定时任务。');
        const isFinished = (t: ScheduledTaskView) => !t.enabled && t.nextRun === '已停用' && t.runCount > 0 && /一次/.test(t.when);
        const tasks = args.includeFinished === true ? all : all.filter((t) => !isFinished(t));
        const hiddenFinished = all.length - tasks.length;
        const lines = tasks.map((t) => {
          const bits = [
            `${t.enabled ? '启用' : '停用'} | ${t.name} | ${t.when} | id=${t.id}`,
            `已执行 ${t.runCount} 次`,
          ];
          if (t.nextRun) bits.push(`下次：${t.nextRun}`);
          if (t.deferredReason) bits.push(`⚠ ${t.deferredReason}`);
          if (t.lastStatus) bits.push(`上次：${t.lastStatus}${t.lastError ? ` — ${t.lastError}` : ''}`);
          return `- ${bits.join(' ; ')}`;
        });
        const w = bridge.window();
        const head = w
          ? `允许工作的时间段：${w.start}–${w.end}${w.days?.length ? `（周 ${w.days.join('/')}）` : ''}；当前${bridge.withinWindow() ? '可开工' : '不在时间段内'}。`
          : '允许工作的时间段：不限制。';
        const tail = hiddenFinished > 0 ? `\n（另有 ${hiddenFinished} 个已跑完的一次性任务未列出，includeFinished=true 可见）` : '';
        const body = lines.length > 0 ? lines.join('\n') : '没有进行中的定时任务。';
        return text(`${head}\n\n${body}${tail}`);
      }

      case 'schedule_cancel': {
        const id = String(args.id ?? '').trim();
        if (!id) return text('schedule_cancel 失败: 缺少 id', false);
        return bridge.remove(id)
          ? text(`已取消定时任务 ${id}。`)
          : text(`没有找到定时任务 ${id}（可能是 id 不对，或正在执行中无法取消）。`, false);
      }

      case 'schedule_window': {
        if (args.clear === true) {
          await setWindow(null);
          return text('已取消工作时间段限制，全天都可以开工。');
        }
        const start = typeof args.start === 'string' ? args.start.trim() : '';
        const end = typeof args.end === 'string' ? args.end.trim() : '';
        if (!start && !end) {
          const w = bridge.window();
          return text(w
            ? `当前允许工作的时间段：${w.start}–${w.end}${w.days?.length ? `（周 ${w.days.join('/')}）` : ''}。`
              + `现在${bridge.withinWindow() ? '可以开工' : '不在时间段内'}。`
            : '当前没有工作时间段限制，全天都可以开工。');
        }
        if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) {
          return text('schedule_window 失败: start 与 end 都需要 HH:MM 格式（例如 09:00 与 18:00）', false);
        }
        const days = Array.isArray(args.days)
          ? args.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
          : undefined;
        await setWindow(days && days.length ? { start, end, days } : { start, end });
        return text(
          `已设置允许工作的时间段：${start}–${end}${days?.length ? `（周 ${days.join('/')}）` : ''}。`
          + '到点但不在时间段内的任务会顺延到下次开窗；已经开跑的不会被中断。',
        );
      }

      default:
        return text(`未知的调度工具: ${name}`, false);
    }
  } catch (err) {
    return text(`${name} 失败: ${(err as Error).message}`, false);
  }
}
