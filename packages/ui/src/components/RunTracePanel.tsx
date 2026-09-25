import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { t } from '../lib/i18n';
import styles from '../styles/RunTracePanel.module.css';

export type RunState = 'running' | 'paused' | 'done' | 'failed';

export interface RunSummary {
  id: string;
  session_id?: string;
  agent?: 'main' | 'subagent';
  model?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  state: RunState;
  prompt: string;
  toolCount: number;
  failedTools: number;
  toolNames?: string[];
  steps: number;
  error?: string;
  reason?: string;
}

export interface RunEvent {
  seq: number;
  ts: string;
  kind: string;
  text?: string;
  chars?: number;
  session_id?: string;
  model?: string;
  agent?: 'main' | 'subagent';
  mode?: string;
  tools?: string[];
  tool?: string;
  args?: string;
  result?: string;
  ms?: number;
  ok?: boolean;
  failure?: string;
  ticket_id?: string;
  path?: string;
  durationMs?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  runs?: string[];
  reason?: string;
}

interface RunsResponse {
  root?: string;
  runs?: RunSummary[];
  total?: number;
  paused?: number;
  failed?: number;
}

interface RunReadResponse {
  run?: RunSummary;
  events?: RunEvent[];
  skipped?: number;
}

/**
 * Labels are produced by functions rather than looked up in a module-level map.
 *
 * A `Record<.., string>` holding the Chinese would be a hardcoded literal that never passes
 * through `t()`, so the panel would stay Chinese in English — and the i18n ratchet would (correctly)
 * count it as new drift. Calling `t()` at render is also the only correct time: the dictionaries are
 * registered after this module is imported, so a module-level `t()` would bake in the source text.
 */
function stateLabel(state: RunState): string {
  switch (state) {
    case 'running': return t('进行中');
    case 'paused': return t('等人工');
    case 'done': return t('完成');
    case 'failed': return t('失败');
  }
}

/** The state's colour, as a CSS-module class. Separate from the label so the two cannot drift. */
function stateClass(state: RunState): string {
  switch (state) {
    case 'running': return styles.stateRunning;
    case 'paused': return styles.statePaused;
    case 'done': return styles.stateDone;
    case 'failed': return styles.stateFailed;
  }
}

/**
 * How each event kind is labelled in the step list.
 *
 * The one that matters is `confirm` reading "等人工确认" rather than "工具": a reader scanning the
 * list has to be able to see that the agent STOPPED and a person decided, because that is the
 * difference between the agent having acted alone and having been authorised.
 */
function kindLabel(kind: string): string {
  switch (kind) {
    case 'start': return t('开始');
    case 'previous': return t('上一轮');
    case 'preflight': return t('预检');
    case 'step': return t('说明');
    case 'tool': return t('工具');
    case 'confirm': return t('等人工确认');
    case 'apply': return t('等应用补丁');
    case 'prune': return t('清理');
    case 'error': return t('出错');
    case 'end': return t('结束');
    // An event kind this build does not know about is shown as-is rather than hidden: a trace from
    // a newer version must not lose rows.
    default: return kind;
  }
}

/** Time of day only: within one workspace the date adds width and nothing else. */
function hhmmss(iso: string | undefined): string {
  if (!iso) return '';
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

function since(iso: string | undefined): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 3600)}h`;
}

function ms(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1000) return `${n}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

/**
 * The run traces.
 *
 * Two panes because the two questions are different: the list answers "what has this workspace been
 * doing" and one run answers "what exactly happened". Rendering them in a single scroller meant the
 * reader had to hold the summary in their head while scrolling for the detail.
 *
 * Read-only, like the audit panel. Nothing here can retract a run or edit a step.
 */
export function RunTracePanel({ onClose, sessionId }: { onClose: () => void; sessionId?: string | null }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [counts, setCounts] = useState({ total: 0, paused: 0, failed: 0 });
  const [root, setRoot] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunReadResponse | null>(null);
  const [onlyThisSession, setOnlyThisSession] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const q = onlyThisSession && sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : '';
      const data = await fetchJSON<RunsResponse>(`/api/runs${q}`);
      const list = data.runs ?? [];
      setRuns(list);
      setCounts({ total: data.total ?? list.length, paused: data.paused ?? 0, failed: data.failed ?? 0 });
      setRoot(data.root ?? '');
      setError(null);
      // Keep a selection that still exists; otherwise fall back to the newest run, so opening the
      // panel always shows something rather than an empty detail pane next to a full list.
      setSelected((cur) => (cur && list.some((r) => r.id === cur) ? cur : (list[0]?.id ?? null)));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [onlyThisSession, sessionId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchJSON<RunReadResponse>(`/api/runs/${encodeURIComponent(selected)}`);
        if (!cancelled) setDetail(data);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [selected, runs]);

  const events = detail?.events ?? [];

  return (
    <div className={styles.panel} data-surface="panel">
      <div className={styles.header}>
        <span className={styles.title}>{t('运行轨迹')}</span>
        <span className={styles.summary}>
          {t('{total} 轮', { total: counts.total })}
          {counts.failed > 0 ? ` · ${t('{n} 轮失败', { n: counts.failed })}` : ''}
          {counts.paused > 0 ? ` · ${t('{n} 轮停在等人工', { n: counts.paused })}` : ''}
        </span>
        <button type="button" className={styles.close} onClick={onClose} title={t('关闭')}>×</button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.filters}>
        <button
          type="button"
          className={`${styles.filter} ${!onlyThisSession ? styles.filterActive : ''}`}
          onClick={() => setOnlyThisSession(false)}
        >
          {t('全部会话')}
        </button>
        <button
          type="button"
          className={`${styles.filter} ${onlyThisSession ? styles.filterActive : ''}`}
          onClick={() => setOnlyThisSession(true)}
          disabled={!sessionId}
        >
          {t('只看当前会话')}
        </button>
        <span className={styles.note}>{t('只读：一轮跑完就不变了')}</span>
      </div>

      {runs.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>◷</div>
          <div className={styles.emptyText}>{t('还没有运行轨迹')}</div>
          <div className={styles.emptyHint}>
            {t('每轮对话都会追加一个文件到 {dir}，记录每一步工具调用、用时和结果。', { dir: '.she/runs/' })}
          </div>
        </div>
      ) : (
        <div className={styles.body}>
          <ol className={styles.list}>
            {runs.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={`${styles.item} ${selected === r.id ? styles.itemActive : ''}`}
                  onClick={() => setSelected(r.id)}
                >
                  <span className={`${styles.badge} ${stateClass(r.state)}`}>{stateLabel(r.state)}</span>
                  <span className={styles.itemPrompt}>{r.prompt || t('（无提问文本）')}</span>
                  <span className={styles.itemMeta}>
                    {hhmmss(r.startedAt)}
                    {r.state === 'running' || r.state === 'paused' ? ` · ${since(r.startedAt)}` : ''}
                    {' · '}
                    {t('{n} 次调用', { n: r.toolCount })}
                    {r.failedTools > 0 ? ` · ${t('{n} 次失败', { n: r.failedTools })}` : ''}
                    {r.durationMs !== undefined ? ` · ${ms(r.durationMs)}` : ''}
                  </span>
                  {/* Stated rather than left to the badge: "failed" alone does not say why, and the
                      reason is the only part a reader can act on. */}
                  {r.reason && r.state !== 'done' ? (
                    <span className={styles.itemReason}>{r.error ?? r.reason}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>

          <div className={styles.detail}>
            {!selected || !detail ? (
              <div className={styles.detailEmpty}>{t('选一轮看它的每一步')}</div>
            ) : (
              <>
                <div className={styles.detailHead}>
                  <code className={styles.runId}>{selected}</code>
                  {detail.run?.model ? <span className={styles.meta}>{detail.run.model}</span> : null}
                  {detail.run?.agent === 'subagent' ? <span className={styles.meta}>{t('子代理')}</span> : null}
                  {detail.run?.session_id ? <span className={styles.meta}>{detail.run.session_id}</span> : null}
                </div>

                {/* Damage reported, not smoothed over: same stance as the audit panel. */}
                {(detail.skipped ?? 0) > 0 ? (
                  <div className={styles.warn}>
                    {t('有 {n} 行无法解析（进程可能在写入中途被杀）', { n: detail.skipped ?? 0 })}
                  </div>
                ) : null}

                <ol className={styles.events}>
                  {events.map((e) => (
                    <li key={`${e.seq}-${e.kind}`} className={`${styles.event} ${styles['ev_' + e.kind] ?? ''}`}>
                      <span className={styles.evSeq}>#{e.seq}</span>
                      <span className={styles.evTime}>{hhmmss(e.ts)}</span>
                      <span className={styles.evKind}>{kindLabel(e.kind)}</span>
                      <div className={styles.evMain}>
                        {e.kind === 'start' ? (
                          <>
                            <div className={styles.evText}>{e.text}</div>
                            <div className={styles.evSub}>
                              {e.tools ? t('可用工具 {n} 个', { n: e.tools.length }) : ''}
                              {e.mode ? ` · ${e.mode}` : ''}
                              {e.agent === 'subagent' ? ` · ${t('子代理')}` : ''}
                            </div>
                          </>
                        ) : null}

                        {e.kind === 'tool' ? (
                          <>
                            <div className={styles.evText}>
                              <code className={styles.tool}>{e.tool}</code>
                              <span className={`${styles.pill} ${e.ok ? styles.pillOk : styles.pillFail}`}>
                                {e.ok ? t('成功') : t('失败')}
                              </span>
                              <span className={styles.evSub}> {ms(e.ms)}</span>
                              {/*
                                The classifier's own word for the failure, shown next to it. The
                                label alone is not actionable; `not_found` versus `timeout` is the
                                difference between a wrong path and a slow endpoint.
                              */}
                              {e.failure ? <span className={styles.evSub}> · {e.failure}</span> : null}
                            </div>
                            {e.args ? <pre className={styles.code}>{e.args}</pre> : null}
                            {e.result ? <pre className={styles.code}>{e.result}</pre> : null}
                          </>
                        ) : null}

                        {e.kind === 'confirm' ? (
                          <div className={styles.evText}>
                            <code className={styles.tool}>{e.tool ?? e.ticket_id}</code>
                            <span className={styles.evSub}>
                              {' '}
                              {t('停在这里等用户批准（工单 {id}）', { id: e.ticket_id ?? '?' })}
                            </span>
                            {e.text ? <div className={styles.evSub}>{e.text}</div> : null}
                          </div>
                        ) : null}

                        {e.kind === 'apply' ? (
                          <div className={styles.evText}>
                            <code className={styles.tool}>{e.path}</code>
                            <span className={styles.evSub}> {t('停在等用户应用补丁')}</span>
                          </div>
                        ) : null}

                        {e.kind === 'end' ? (
                          <div className={styles.evText}>
                            {e.ok ? t('本轮完成') : t('本轮没有正常收尾')}
                            {e.reason ? ` · ${e.reason}` : ''}
                            {e.durationMs !== undefined ? ` · ${ms(e.durationMs)}` : ''}
                            {e.usage?.total_tokens ? ` · ${t('{n} tokens', { n: e.usage.total_tokens })}` : ''}
                            {e.text ? <div className={styles.evSub}>{e.text}</div> : null}
                          </div>
                        ) : null}

                        {['previous', 'preflight', 'step', 'prune', 'error'].includes(e.kind) ? (
                          <>
                            <div className={styles.evText}>{e.text}</div>
                            {/* A truncated field records its original length, so a cut record is not
                                read as a short complete one. */}
                            {e.chars !== undefined ? (
                              <div className={styles.evSub}>{t('已截断，原文 {n} 字', { n: e.chars })}</div>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        </div>
      )}

      {root ? <div className={styles.footer}>{t('文件：{list}', { list: root })}</div> : null}
    </div>
  );
}
