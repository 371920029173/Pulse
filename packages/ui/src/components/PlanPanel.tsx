import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import styles from '../styles/PlanPanel.module.css';

export type StepStatus = 'pending' | 'active' | 'done' | 'blocked' | 'dropped';

export interface PlanStep {
  id: string;
  title: string;
  status: StepStatus;
  note?: string;
  updatedAt: string;
}

export interface Plan {
  id: string;
  title: string;
  goal?: string;
  status: 'open' | 'done' | 'abandoned';
  steps: PlanStep[];
  createdAt: string;
  updatedAt: string;
}

const MARK: Record<StepStatus, string> = {
  pending: '○',
  active: '◐',
  done: '●',
  blocked: '!',
  dropped: '–',
};

const LABEL: Record<StepStatus, string> = {
  pending: '待办',
  active: '进行中',
  done: '完成',
  blocked: '受阻',
  dropped: '已弃',
};

/** Long-horizon plan view. Plans are written by the agent via plan_* tools. */
export function PlanPanel({ onClose, sessionId }: { onClose: () => void; sessionId?: string | null }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const q = sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
      const data = await fetchJSON<{ plans: Plan[] }>(`/api/plans${q}`);
      setPlans(data.plans ?? []);
      setError(null);
      setSelected((cur) => cur ?? data.plans?.[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const setStepStatus = useCallback(
    async (planId: string, stepId: string, status: StepStatus) => {
      setBusy(true);
      try {
        await fetchJSON('/api/plans/step', {
          method: 'POST',
          body: { plan_id: planId, step_id: stepId, status, session_id: sessionId ?? undefined },
        });
        await refresh();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const current = plans.find((p) => p.id === selected) ?? plans[0] ?? null;
  const doneCount = current ? current.steps.filter((s) => s.status === 'done').length : 0;

  return (
    <div className={styles.panel} data-surface="panel">
      <div className={styles.header}>
        <span className={styles.title}>长程计划</span>
        <button type="button" className={styles.close} onClick={onClose} title="关闭">×</button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      {plans.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>◐</div>
          <div className={styles.emptyText}>还没有计划</div>
          <div className={styles.emptyHint}>
            让智能体处理多步骤任务时，它会用 <code>plan_create</code> 立计划，进度会显示在这里。
          </div>
        </div>
      ) : (
        <>
          {plans.length > 1 ? (
            <div className={styles.planTabs}>
              {plans.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`${styles.planTab} ${p.id === current?.id ? styles.planTabActive : ''}`}
                  onClick={() => setSelected(p.id)}
                >
                  {p.title}
                </button>
              ))}
            </div>
          ) : null}

          {current ? (
            <div className={styles.body}>
              <div className={styles.planHead}>
                <div className={styles.planTitle}>{current.title}</div>
                <div className={styles.planMeta}>
                  {doneCount}/{current.steps.length} 完成 ·{' '}
                  <span className={`${styles.planStatus} ${styles['status_' + current.status]}`}>
                    {current.status === 'open' ? '进行中' : current.status === 'done' ? '已完成' : '已放弃'}
                  </span>
                </div>
                {current.goal ? <div className={styles.planGoal}>{current.goal}</div> : null}
              </div>

              <ol className={styles.steps}>
                {current.steps.map((s) => (
                  <li key={s.id} className={`${styles.step} ${styles['step_' + s.status]}`}>
                    <button
                      type="button"
                      className={styles.stepMark}
                      disabled={busy}
                      onClick={() =>
                        void setStepStatus(
                          current.id,
                          s.id,
                          s.status === 'done' ? 'pending' : 'done',
                        )
                      }
                      title={s.status === 'done' ? '标记为未完成' : '标记为完成'}
                    >
                      {MARK[s.status]}
                    </button>
                    <div className={styles.stepMain}>
                      <div className={styles.stepTitle}>
                        <span className={styles.stepId}>{s.id}</span>
                        {s.title}
                      </div>
                      {s.note ? <div className={styles.stepNote}>{s.note}</div> : null}
                    </div>
                    <span className={styles.stepLabel}>{LABEL[s.status]}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
