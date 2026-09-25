import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { t } from '../lib/i18n';
import styles from '../styles/AuditPanel.module.css';

export type AuditKind = 'request' | 'tool' | 'confirm' | 'rotation';

export interface AuditRecord {
  ts: string;
  seq: number;
  kind: AuditKind;
  session_id?: string;
  message?: string;
  chars?: number;
  truncated?: boolean;
  tool?: string;
  ms?: number;
  ok?: boolean;
  ticket_id?: string;
  approved?: boolean;
  dropped?: string[];
  note?: string;
}

interface AuditResponse {
  files?: string[];
  skipped_lines?: number;
  records?: AuditRecord[];
}

const KIND_LABEL: Record<AuditKind, string> = {
  request: '请求',
  tool: '工具',
  confirm: '确认',
  rotation: '轮转',
};

const FILTERS: Array<{ id: AuditKind | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'request', label: '请求' },
  { id: 'tool', label: '工具' },
  { id: 'confirm', label: '确认' },
];

/** Time of day only: the date is implied by the trail and the seconds are what are compared. */
function hhmmss(iso: string): string {
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

/**
 * The audit trail.
 *
 * Read-only on purpose, and the panel says so rather than leaving it ambiguous: every other
 * panel here edits the thing it shows, and a trail that could be edited from the same screen it
 * is displayed on would not be worth keeping.
 */
export function AuditPanel({ onClose }: { onClose: () => void }) {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [filter, setFilter] = useState<AuditKind | 'all'>('all');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const q = filter === 'all' ? '' : `?kind=${filter}`;
      const data = await fetchJSON<AuditResponse>(`/api/audit${q}`);
      setRecords(data.records ?? []);
      setFiles(data.files ?? []);
      setSkipped(data.skipped_lines ?? 0);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <div className={styles.panel} data-surface="panel">
      <div className={styles.header}>
        <span className={styles.title}>{t('审计记录')}</span>
        <button type="button" className={styles.close} onClick={onClose} title={t('关闭')}>×</button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.filters}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`${styles.filter} ${filter === f.id ? styles.filterActive : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {t(f.label)}
          </button>
        ))}
        <span className={styles.note}>{t('只读：界面不提供改/删记录')}</span>
      </div>

      {/*
        Damage is stated, not hidden. A trail with unreadable lines that reports nothing looks
        exactly like a quiet day, which is the one reading that must not be available.
      */}
      {skipped > 0 ? (
        <div className={styles.warn}>
          {t('有 {n} 行无法解析（进程可能在写入中途被杀）', { n: skipped })}
        </div>
      ) : null}

      {records.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>▤</div>
          <div className={styles.emptyText}>{t('还没有记录')}</div>
          <div className={styles.emptyHint}>
            {t('请求、工具调用、人工确认都会追加到 {file}，只增不改。', { file: '.she/audit.log' })}
          </div>
        </div>
      ) : (
        <ol className={styles.rows}>
          {records.map((r) => (
            <li key={`${r.seq}-${r.ts}`} className={`${styles.row} ${styles['row_' + r.kind]}`}>
              <span className={styles.seq}>#{r.seq}</span>
              <span className={styles.time}>{hhmmss(r.ts)}</span>
              <span className={styles.kind}>{t(KIND_LABEL[r.kind])}</span>
              <div className={styles.main}>
                {r.kind === 'request' ? (
                  <>
                    <div className={styles.text}>{r.message ?? ''}</div>
                    {r.truncated ? (
                      <div className={styles.sub}>
                        {t('已截断，原文 {n} 字', { n: r.chars ?? 0 })}
                      </div>
                    ) : null}
                  </>
                ) : null}
                {r.kind === 'tool' ? (
                  <div className={styles.text}>
                    <code className={styles.tool}>{r.tool}</code>
                    <span className={styles.sub}>
                      {' '}
                      {r.ok ? t('成功') : t('失败')} · {r.ms ?? 0}ms
                    </span>
                  </div>
                ) : null}
                {r.kind === 'confirm' ? (
                  <div className={styles.text}>
                    <code className={styles.tool}>{r.tool ?? r.ticket_id}</code>
                    <span className={styles.sub}> {r.approved ? t('用户已批准') : t('用户已拒绝')}</span>
                    {r.note ? <div className={styles.sub}>{r.note}</div> : null}
                  </div>
                ) : null}
                {r.kind === 'rotation' ? (
                  <div className={styles.text}>
                    {t('日志轮转，丢弃 {list}', { list: (r.dropped ?? []).join('、') })}
                  </div>
                ) : null}
                {r.session_id ? <div className={styles.sub}>{r.session_id}</div> : null}
              </div>
            </li>
          ))}
        </ol>
      )}

      {files.length ? (
        <div className={styles.footer}>
          {t('文件：{list}', { list: files.join('、') })}
        </div>
      ) : null}
    </div>
  );
}
