import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { t } from '../lib/i18n';
import styles from '../styles/PlanPanel.module.css';

export type StepStatus = 'pending' | 'active' | 'done' | 'blocked' | 'dropped';
export type FailurePolicy = 'retry' | 'skip' | 'stop' | 'ask';

export interface PlanStep {
  id: string;
  title: string;
  status: StepStatus;
  /** Steps that must be `done` before this one may start. */
  dependsOn?: string[];
  onFailure?: FailurePolicy;
  /** Times this step has been marked blocked. */
  attempts?: number;
  note?: string;
  updatedAt: string;
}

export interface Plan {
  id: string;
  title: string;
  goal?: string;
  status: 'open' | 'done' | 'abandoned';
  steps: PlanStep[];
  /** Where the plan resumes, computed server-side from the same rule the agent reads. */
  next?: { stepId: string; title: string; why: string } | null;
  /**
   * The conversation that created this plan.
   *
   * Plans are workspace-level, so this is **provenance, not ownership** — it lets the panel say
   * "this one was started in the other chat" without restricting who may read or continue it.
   */
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The policy in words, built at render time rather than stored as literals in a map.
 *
 * `t()` keys on the source text, so the Chinese has to stay in the source — but as a direct
 * argument to `t(...)`, which is what the coverage check counts as translated. A pre-built map
 * of Chinese labels would read as four untranslated strings.
 */
function policyLabel(policy: FailurePolicy): string {
  switch (policy) {
    case 'retry':
      return t('失败后重试');
    case 'skip':
      return t('失败后跳过');
    case 'ask':
      return t('失败后问用户');
    case 'stop':
      return t('失败后停下等你决定');
  }
}

const MARK: Record<StepStatus, string> = {
  pending: '○',
  active: '◐',
  done: '●',
  blocked: '!',
  dropped: '–',
};

const LABEL: Record<StepStatus, string> = {
  pending: t('待办'),
  active: t('进行中'),
  done: t('完成'),
  blocked: t('受阻'),
  dropped: t('已弃'),
};

/**
 * Long-horizon plan view. Plans are written by the agent via plan_* tools.
 *
 * Plans belong to the WORKSPACE (`.she/plans.json`): every chat in this project reads and writes the
 * same file, so this panel shows the PROJECT's plans — a long task started in another conversation is
 * right here, and progress made here is visible to the next chat. Each plan carries the conversation
 * that created it, shown as provenance: it says where the work came from without deciding who may
 * continue it.
 *
 * 这里曾经有「其他会话」选择器和只读模式，那是"计划按会话分文件"的产物：别的会话的计划不在当前文件
 * 里，所以要么开一扇门去看（只读），要么看不见。现在本工作区的计划全部就在这里，没有需要靠那扇门才
 * 能看到的东西，也就可以直接在这里改进度。
 */
export function PlanPanel({ onClose, sessionId }: { onClose: () => void; sessionId?: string | null }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      /*
       * 不带 session_id：服务端按**工作区作用域**解析，拿到的就是本项目的全部计划。带上 id 也不会
       * 改变读的范围（它只是来源标记），不带反而更能说明这里读的是"这个项目的计划"。
       */
      const data = await fetchJSON<{ plans: Plan[] }>('/api/plans');
      setPlans(data.plans ?? []);
      setError(null);
      setSelected((cur) => (cur && data.plans?.some((p) => p.id === cur) ? cur : data.plans?.[0]?.id ?? null));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
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
    [refresh, sessionId],
  );

  const current = plans.find((p) => p.id === selected) ?? plans[0] ?? null;
  const doneCount = current ? current.steps.filter((s) => s.status === 'done').length : 0;

  return (
    <div className={styles.panel} data-surface="panel">
      <div className={styles.header}>
        <span className={styles.title}>{t('长程计划')}</span>
        <div className={styles.headerActions}>
          <button type="button" className={styles.close} onClick={onClose} title={t('关闭')}>×</button>
        </div>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      {plans.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>◐</div>
          <div className={styles.emptyText}>{t('还没有计划')}</div>
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
                  {doneCount}/{current.steps.length} {t('完成')} ·{' '}
                  <span className={`${styles.planStatus} ${styles['status_' + current.status]}`}>
                    {current.status === 'open' ? t('进行中') : current.status === 'done' ? t('已完成') : t('已放弃')}
                  </span>
                </div>
                {current.goal ? <div className={styles.planGoal}>{current.goal}</div> : null}
                {/*
                  Which conversation started this plan.

                  Shown because the plan is the project's, not this chat's: without this line a plan
                  resumed from yesterday looks as if it were created here. It is provenance, so it
                  does not gate anything — the steps below are editable either way.
                */}
                {current.sessionId && current.sessionId !== sessionId ? (
                  <div className={styles.planOrigin}>
                    {t('来自其他会话 · {id}', { id: current.sessionId })}
                  </div>
                ) : null}
                {/*
                  The resume point, next to the marks rather than left for the reader to derive.
                  This is the line that answers "where does it continue" after a restart, and it
                  comes from the server so it cannot disagree with what the agent is told.
                */}
                {current.next ? (
                  <div className={styles.planNext}>
                    {t('下一步：{id} {title}', { id: current.next.stepId, title: current.next.title })}
                    <span className={styles.planNextWhy}>{current.next.why}</span>
                  </div>
                ) : (
                  <div className={styles.planNext}>{t('下一步：无，计划已收口')}</div>
                )}
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
                      title={s.status === 'done' ? t('标记为未完成') : t('标记为完成')}
                    >
                      {MARK[s.status]}
                    </button>
                    <div className={styles.stepMain}>
                      <div className={styles.stepTitle}>
                        <span className={styles.stepId}>{s.id}</span>
                        {s.title}
                      </div>
                      {s.dependsOn?.length ? (
                        <div className={styles.stepNote}>
                          {t('依赖：{deps}', { deps: s.dependsOn.join('、') })}
                        </div>
                      ) : null}
                      {s.onFailure && s.onFailure !== 'stop' ? (
                        <div className={styles.stepNote}>{policyLabel(s.onFailure)}</div>
                      ) : null}
                      {s.attempts ? (
                        <div className={styles.stepNote}>{t('已试 {n} 次', { n: s.attempts })}</div>
                      ) : null}
                      {s.note ? <div className={styles.stepNote}>{s.note}</div> : null}
                    </div>
                    <span className={styles.stepLabel}>{t(LABEL[s.status])}</span>
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
