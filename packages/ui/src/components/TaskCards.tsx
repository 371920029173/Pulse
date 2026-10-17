import { useCallback, useEffect, useRef, useState } from 'react';
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
  /*
   * 默认**收起**：用户的原话是「子代理的窗口处理，我建议设为默认隐藏，可以在历史记录里打开看」。
   * 收起时只剩一枚小按钮（有任务时才出现），点开才铺开卡片；展开状态记在 localStorage，和别的
   * 界面状态一样跟着工作区跨重启（she.* 前缀会被 lib/uiState.ts 同步）。
   */
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem('she.bgTasks.open') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('she.bgTasks.open', open ? '1' : '0'); } catch { /* ignore */ }
  }, [open]);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchJSON<{ tasks: TaskCard[] }>('/api/tasks');
      setTasks(data.tasks || []);
    } catch {
      /* optional */
    }
  }, []);

  /*
   * 降频到 5 秒，并且窗口在后台时不拉：这条轮询每个窗口都开着，而卡片是"看一眼就走"的东西。
   * （原来是 1500ms；多窗口时这些常驻轮询是服务器单线程上最容易被忽略的那部分负载。）
   */
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void refresh();
    }, 5_000);
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

  /*
   * 这个列表**只放正在跑的**（用户的原话：「直接把已经完成的事从提示列表里踢了不就行了」）。
   * 结束的卡片既不显示、也不占位、也不会"清除了又跳出来"—— 没有在跑的就整块消失。
   */
  const running = tasks.filter((task) => task.phase === 'running');
  if (!running.length) return null;

  if (!open) {
    /*
     * 收起态：只报"有几件事在跑"。没有跑着的任务就什么都不显示 —— 面板不再是常驻的。
     */
    return (
      <button
        type="button"
        className={styles.pill}
        onClick={() => setOpen(true)}
        title={t('展开后台任务')}
      >
        {t('后台任务')}{running.length ? ` · ${running.length} ${t('进行中')}` : ''}
      </button>
    );
  }

  return (
    <div className={styles.wrap} aria-live="polite">
      <div className={styles.head}>
        <span className={styles.title}>{t('后台任务')}{running.length ? ` · ${running.length} ${t('进行中')}` : ''}</span>
        <button type="button" className={styles.ghost} onClick={() => setOpen(false)}>
          {t('收起')}
        </button>
      </div>
      <div className={styles.list}>
        {/*
          The callback parameter is `task`, not `t`.
          The i18n helper is a module-level `t()`, so a parameter named `t` shadows it and every
          `t('…')` inside the block fails to compile — the same collision that was fixed once before
          in `SchedulePanel`. Naming it `task` makes the shadowing impossible.
        */}
        {running.slice(0, 8).map((task) => (
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
