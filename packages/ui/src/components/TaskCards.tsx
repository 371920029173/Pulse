import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import styles from '../styles/TaskCards.module.css';
import { t } from '../lib/i18n';

interface TaskCard {
  id: string;
  kind: string;
  label: string;
  phase: 'running' | 'done' | 'error';
  detail?: string;
  updated_at: string;
}

export function TaskCards() {
  const [tasks, setTasks] = useState<TaskCard[]>([]);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchJSON<{ tasks: TaskCard[] }>('/api/tasks');
      setTasks(data.tasks || []);
    } catch {
      /* optional */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Also accept live SSE task events from chat via custom event
  useEffect(() => {
    const onLive = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as TaskCard | undefined;
      if (!detail?.id) return;
      setTasks((prev) => {
        const rest = prev.filter((t) => t.id !== detail.id);
        return [detail, ...rest].slice(0, 40);
      });
    };
    const onFailed = (ev: Event) => {
      const message = String((ev as CustomEvent).detail?.message || t('连接中断'));
      setTasks((prev) =>
        prev.map((t) =>
          t.phase === 'running' ? { ...t, phase: 'error' as const, detail: message } : t,
        ),
      );
      void fetchJSON('/api/tasks/mark-stale', { method: 'POST', body: { reason: message } }).catch(() => undefined);
    };
    window.addEventListener('she:task', onLive);
    window.addEventListener('she:stream-failed', onFailed);
    window.addEventListener('she:offline', onFailed);
    return () => {
      window.removeEventListener('she:task', onLive);
      window.removeEventListener('she:stream-failed', onFailed);
      window.removeEventListener('she:offline', onFailed);
    };
  }, []);

  async function dismiss(id: string) {
    try {
      await fetchJSON(`/api/tasks/${id}`, { method: 'DELETE' });
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch {
      setTasks((prev) => prev.filter((t) => t.id !== id));
    }
  }

  async function clearFinished() {
    try {
      await fetchJSON('/api/tasks/clear-finished', { method: 'POST', body: {} });
      await refresh();
    } catch {
      setTasks((prev) => prev.filter((t) => t.phase === 'running'));
    }
  }

  if (!tasks.length) return null;

  const running = tasks.filter((t) => t.phase === 'running').length;

  return (
    <div className={styles.wrap} aria-live="polite">
      <div className={styles.head}>
        <span className={styles.title}>{t('后台任务')}{running ? ` · ${running} ${t('进行中')}` : ''}</span>
        <button type="button" className={styles.ghost} onClick={() => void clearFinished()}>
          {t('清除已结束')}
        </button>
      </div>
      <div className={styles.list}>
        {/*
          The callback parameter is `task`, not `t`.
          The i18n helper is a module-level `t()`, so a parameter named `t` shadows it and every
          `t('…')` inside the block fails to compile — the same collision that was fixed once before
          in `SchedulePanel`. Naming it `task` makes the shadowing impossible.
        */}
        {tasks.slice(0, 8).map((task) => (
          <div key={task.id} className={`${styles.card} ${styles[task.phase]}`}>
            <div className={styles.row}>
              <span className={styles.kind}>{task.kind === 'subagent' ? t('子智能体') : task.kind === 'import' ? t('导入') : task.kind}</span>
              <button type="button" className={styles.x} onClick={() => void dismiss(task.id)} title={t('关闭')}>
                ×
              </button>
            </div>
            <div className={styles.label}>{task.label}</div>
            {task.detail ? <div className={styles.detail}>{task.detail}</div> : null}
            <div className={styles.phase}>
              {task.phase === 'running' ? t('进行中…') : task.phase === 'done' ? t('完成') : t('失败')}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
