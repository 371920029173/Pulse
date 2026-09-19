import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { t } from '../lib/i18n';
import { toast } from '../lib/toast';
import styles from '../styles/SchedulePanel.module.css';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

/** A task as `/api/schedule` reports it. */
interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  trigger: { kind: 'once'; at: string } | { kind: 'interval'; everyMinutes: number } | { kind: 'daily'; at: string };
  window?: { start: string; end: string; days?: number[] } | null;
  overlap: 'skip' | 'queue';
  softLimitMinutes?: number;
  lastStatus?: string;
  lastError?: string;
  lastDeferredReason?: string;
  lastOverran?: boolean;
  runCount: number;
  sessionId?: string;
  nextRun?: string;
}

interface ScheduleSnapshot {
  enabled: boolean;
  tickSeconds: number;
  workingWindow: { start: string; end: string; days?: number[] } | null;
  withinWindow: boolean;
  nextWindowStart: string | null;
  running: string[];
  tasks: ScheduledTask[];
}

const DAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

function describeTrigger(trigger: ScheduledTask['trigger']): string {
  if (trigger.kind === 'once') return t('一次性 {time}', { time: new Date(trigger.at).toLocaleString() });
  if (trigger.kind === 'daily') return t('每天 {time}', { time: trigger.at });
  return t('每 {n} 分钟', { n: trigger.everyMinutes });
}

/*
 * The parameter is `task`, not `t`: this file also imports the translation
 * function `t`, and naming the parameter `t` shadows it — so every translated
 * string in here would try to call a task object. The type checker caught it the
 * moment the strings were converted.
 */
function statusLabel(task: ScheduledTask, running: boolean): { text: string; tone: string } {
  if (running) return { text: t('执行中'), tone: 'running' };
  if (task.lastDeferredReason) return { text: t('已顺延'), tone: 'deferred' };
  if (task.lastStatus === 'error') return { text: t('上次失败'), tone: 'error' };
  if (task.lastOverran) return { text: t('上次超时'), tone: 'warn' };
  if (task.lastStatus === 'ok') return { text: t('上次成功'), tone: 'ok' };
  if (!task.enabled) return { text: t('已停用'), tone: 'off' };
  return { text: t('待执行'), tone: 'idle' };
}

/**
 * Scheduled tasks.
 *
 * The panel leads with the working window rather than the task list, because the
 * window is what explains why a task the user expected to have run has not: it is
 * DEFERRED, not lost. Getting that wrong is the main way a scheduler appears
 * broken, so the state is stated outright ("当前可开工" / "顺延到 …") instead of
 * leaving the user to infer it from timestamps.
 */
export function SchedulePanel({ onClose }: { onClose?: () => void }) {
  // Escape closes this dialog: the backdrop click is a mouse convenience, not a keyboard path.
  useEscapeToClose(onClose);

  const [snap, setSnap] = useState<ScheduleSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState({ name: '', prompt: '', kind: 'daily', at: '09:00', everyMinutes: 60 });

  const load = useCallback(async () => {
    try {
      setSnap(await fetchJSON<ScheduleSnapshot>('/api/schedule'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = useCallback(async () => {
    if (busy) return;
    if (!draft.name.trim() || !draft.prompt.trim()) {
      toast(t('任务需要名称和指令'));
      return;
    }
    const trigger = draft.kind === 'interval'
      ? { kind: 'interval' as const, everyMinutes: Number(draft.everyMinutes) }
      : { kind: draft.kind as 'once' | 'daily', at: draft.at };
    setBusy('create');
    try {
      await fetchJSON('/api/schedule', { method: 'POST', body: { name: draft.name, prompt: draft.prompt, trigger } });
      setShowForm(false);
      setDraft({ name: '', prompt: '', kind: 'daily', at: '09:00', everyMinutes: 60 });
      toast(t('已添加定时任务'));
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [busy, draft, load]);

  const act = useCallback(async (id: string, action: 'toggle' | 'run' | 'delete', enabled?: boolean) => {
    if (busy) return;
    setBusy(id + action);
    try {
      if (action === 'toggle') {
        await fetchJSON(`/api/schedule/${id}`, { method: 'PUT', body: { enabled } });
      } else if (action === 'run') {
        await fetchJSON(`/api/schedule/${id}/run`, { method: 'POST', body: {} });
        toast(t('已开始执行，结果会写进对应会话'));
      } else {
        await fetchJSON(`/api/schedule/${id}`, { method: 'DELETE' });
        toast(t('已删除'));
      }
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [busy, load]);

  const setWindow = useCallback(async (patch: { start?: string; end?: string; days?: number[]; clear?: boolean }) => {
    if (busy) return;
    setBusy('window');
    try {
      await fetchJSON('/api/schedule/window', { method: 'PUT', body: patch });
      await load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [busy, load]);

  const tasks = snap?.tasks ?? [];
  const running = new Set(snap?.running ?? []);

  return (
    <div className={styles.overlay} data-surface="backdrop" onClick={onClose ? () => onClose() : undefined}>
      <section className={styles.panel} data-surface="panel" onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <div className={styles.headerMain}>
            <h2 className={styles.title}>{t('定时任务')}</h2>
            <span className={styles.sub}>
              {t('到点自动干活；可设置允许工作的时间段')}
            </span>
          </div>
          {onClose ? (
            <button type="button" className={styles.close} onClick={onClose} title={t('关闭')}>×</button>
          ) : null}
        </header>

        {error ? <div className={styles.error}>{error}</div> : null}

        <div className={styles.toolbar}>
          <button type="button" className={styles.primary} onClick={() => setShowForm((v) => !v)}>
            {showForm ? t('取消') : t('+ 新建')}
          </button>
          <span className={styles.hint}>
            {t('也可以在对话里说「每天早上检查一下构建」')}
          </span>
        </div>

        <div className={styles.body}>
          <div className={styles.windowBox}>
            <div className={styles.windowRow}>
              <span className={styles.windowLabel}>{t('允许工作的时间段')}</span>
              <span className={snap?.withinWindow ? styles.gateOpen : styles.gateClosed}>
                {snap?.withinWindow ? t('当前可开工') : t('当前不在时段内')}
              </span>
            </div>
            {snap?.workingWindow ? (
              <div className={styles.windowDetail}>
                {snap.workingWindow.start}–{snap.workingWindow.end}
                {snap.workingWindow.days?.length
                  ? ` · 周${snap.workingWindow.days.map((d) => DAY_LABELS[d] ?? d).join('')}`
                  : t('· 每天')}
                {!snap.withinWindow && snap.nextWindowStart
                  ? ` · ${t('下次开窗')} ${new Date(snap.nextWindowStart).toLocaleString()}`
                  : ''}
              </div>
            ) : (
              <div className={styles.windowDetail}>{t('未限制，任何时间都可以开工')}</div>
            )}
            <div className={styles.windowActions}>
              <input
                type="time"
                className={styles.timeInput}
                defaultValue={snap?.workingWindow?.start ?? '09:00'}
                onBlur={(e) => setWindow({ start: e.target.value, end: snap?.workingWindow?.end ?? '18:00' })}
                title="开始时间"
              />
              <span className={styles.dash}>–</span>
              <input
                type="time"
                className={styles.timeInput}
                defaultValue={snap?.workingWindow?.end ?? '18:00'}
                onBlur={(e) => setWindow({ start: snap?.workingWindow?.start ?? '09:00', end: e.target.value })}
                title="结束时间"
              />
              <button type="button" className={styles.ghost} onClick={() => setWindow({ start: '09:00', end: '18:00' })}>
                {t('应用')}
              </button>
              <button type="button" className={styles.ghost} onClick={() => setWindow({ clear: true })}>
                {t('取消限制')}
              </button>
            </div>
            <p className={styles.hint}>
              {t('时段外到点的任务会')}<strong>{t('顺延')}</strong>{t('到下次开窗，不会被丢弃；')}
              {t('已经在跑的')}<strong>{t('绝不会')}</strong>{t('因为时段结束而中断。')}
            </p>
          </div>

          {showForm ? (
            <div className={styles.form}>
              <input
                className={styles.input}
                placeholder={t('任务名称，例如 每日构建检查')}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <textarea
                className={styles.textarea}
                placeholder={t('到点要做什么？写得像你对助手说的一句话')}
                rows={3}
                value={draft.prompt}
                onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              />
              <div className={styles.formRow}>
                <select
                  className={styles.select}
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
                >
                  <option value="daily">{t('每天')}</option>
                  <option value="interval">{t('每隔一段时间')}</option>
                  <option value="once">{t('只执行一次')}</option>
                </select>
                {draft.kind === 'interval' ? (
                  <input
                    className={styles.input}
                    type="number"
                    min={1}
                    value={draft.everyMinutes}
                    onChange={(e) => setDraft({ ...draft, everyMinutes: Number(e.target.value) })}
                    title={t('间隔（分钟）')}
                  />
                ) : (
                  <input
                    className={styles.input}
                    type={draft.kind === 'once' ? 'datetime-local' : 'time'}
                    value={draft.at}
                    onChange={(e) => setDraft({ ...draft, at: e.target.value })}
                  />
                )}
                <button type="button" className={styles.primary} onClick={() => void create()} disabled={busy === 'create'}>
                  {t('添加')}
                </button>
              </div>
            </div>
          ) : null}

          {tasks.length === 0 ? (
            <div className={styles.empty}>
              {t('还没有定时任务。点「+ 新建」开始，或在对话里直接说需求。')}
            </div>
          ) : (
            <ul className={styles.list}>
              {tasks.map((task) => {
                const st = statusLabel(task, running.has(task.id));
                return (
                  <li key={task.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <span className={styles.itemName}>{task.name}</span>
                      <span className={`${styles.badge} ${styles[`tone_${st.tone}`] ?? ''}`}>{st.text}</span>
                    </div>
                    <div className={styles.itemMeta}>
                      {describeTrigger(task.trigger)}
                      {task.nextRun ? ` · ${task.nextRun}` : ''}
                      {` · ${t('已执行 {n} 次', { n: task.runCount })}`}
                    </div>
                    {task.lastDeferredReason ? (
                      <div className={styles.deferredNote}>{task.lastDeferredReason}</div>
                    ) : null}
                    {task.lastError ? <div className={styles.error}>{task.lastError}</div> : null}
                    <div className={styles.itemActions}>
                      <button
                        type="button"
                        className={styles.ghost}
                        disabled={busy === task.id + 'toggle'}
                        onClick={() => void act(task.id, 'toggle', !task.enabled)}
                      >
                        {task.enabled ? t('停用') : t('启用')}
                      </button>
                      <button
                        type="button"
                        className={styles.ghost}
                        disabled={!!busy || running.has(task.id)}
                        onClick={() => void act(task.id, 'run')}
                      >
                        {t('立即执行')}
                      </button>
                      <button
                        type="button"
                        className={styles.danger}
                        disabled={!!busy || running.has(task.id)}
                        onClick={() => {
                          if (window.confirm(t('删除定时任务「{name}」？此操作不可撤销。', { name: task.name }))) {
                            void act(task.id, 'delete');
                          }
                        }}
                      >
                        {t('删除')}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
