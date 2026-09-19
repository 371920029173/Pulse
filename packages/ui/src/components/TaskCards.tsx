import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import styles from '../styles/TaskCards.module.css';

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
      const message = String((ev as CustomEvent).detail?.message || '连接中断');
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
        <span className={styles.title}>后台任务{running ? ` · ${running} 进行中` : ''}</span>
        <button type="button" className={styles.ghost} onClick={() => void clearFinished()}>
          清除已结束
        </button>
      </div>
      <div className={styles.list}>
        {tasks.slice(0, 8).map((t) => (
          <div key={t.id} className={`${styles.card} ${styles[t.phase]}`}>
            <div className={styles.row}>
              <span className={styles.kind}>{t.kind === 'subagent' ? '子智能体' : t.kind === 'import' ? '导入' : t.kind}</span>
              <button type="button" className={styles.x} onClick={() => void dismiss(t.id)} title="关闭">
                ×
              </button>
            </div>
            <div className={styles.label}>{t.label}</div>
            {t.detail ? <div className={styles.detail}>{t.detail}</div> : null}
            <div className={styles.phase}>
              {t.phase === 'running' ? '进行中…' : t.phase === 'done' ? '完成' : '失败'}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
