import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { toast } from '../lib/toast';
import styles from '../styles/SessionHistory.module.css';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

export interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  closed?: boolean;
  closed_at?: string;
}

interface Props {
  onClose: () => void;
  /** Called after reopening a session, so the app can switch to it. */
  onReopened?: (id: string) => void;
}

function fmtWhen(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return d.toISOString().slice(0, 10);
}

/**
 * History: every chat still on disk, including closed ones.
 *
 * Closing hides a session from the working list without losing it; this is
 * where they can be found and reopened. Deleted sessions are gone for good and
 * never appear here.
 */
export function SessionHistory({ onClose, onReopened }: Props) {
  // Escape closes this dialog: the backdrop click is a mouse convenience, not a keyboard path.
  useEscapeToClose(onClose);

  const [open, setOpen] = useState<SessionRow[]>([]);
  const [closed, setClosed] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetchJSON<{ closed: SessionRow[]; open: SessionRow[] }>('/api/sessions/history');
      setClosed(d.closed ?? []);
      setOpen(d.open ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    // No tabs: history shows every conversation that still exists, newest first.
    const sorted = [...open, ...closed].sort((a, b) =>
      (b.updated_at ?? '').localeCompare(a.updated_at ?? ''),
    );
    const q = query.trim().toLowerCase();
    return q ? sorted.filter((s) => s.title.toLowerCase().includes(q)) : sorted;
  }, [open, closed, query]);

  const reopen = useCallback(async (id: string) => {
    setBusy(id);
    try {
      await fetchJSON(`/api/sessions/${id}/reopen`, { method: 'POST', body: {} });
      toast('已恢复该对话');
      await load();
      onReopened?.(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [load, onReopened]);

  return (
    <div className={styles.backdrop} data-surface="backdrop" onClick={onClose}>
      <div className={styles.panel} data-surface="panel" onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <div className={styles.headerMain}>
            <h2 className={styles.title}>历史记录</h2>
            <span className={styles.sub}>{rows.length} 个对话（含已关闭，不含已删除）</span>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>Esc</button>
        </header>

        <div className={styles.toolbar}>
          <input
            className={styles.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索历史对话…"
            spellCheck={false}
          />
        </div>

        {error ? <div className={styles.error}>{error}</div> : null}

        <div className={styles.body}>
          {loading ? (
            <div className={styles.empty}>读取中…</div>
          ) : rows.length === 0 ? (
            <div className={styles.empty}>
              {query ? '没有匹配的对话。' : '还没有任何对话记录。'}
            </div>
          ) : (
            rows.map((s) => (
              <div key={s.id} className={`${styles.row} ${s.closed ? styles.rowClosed : ''}`}>
                <span className={`${styles.dot} ${s.closed ? styles.dotClosed : ''}`} />
                <div className={styles.main}>
                  <div className={styles.name}>{s.title || 'New chat'}</div>
                  <div className={styles.meta}>
                    <span>创建 {fmtWhen(s.created_at)}</span>
                    <span>活跃 {fmtWhen(s.updated_at)}</span>
                    {s.closed ? <span className={styles.tagClosed}>已关闭</span> : null}
                    <span className={styles.id}>{s.id.slice(-6)}</span>
                  </div>
                </div>
                {s.closed ? (
                  <button
                    type="button"
                    className={styles.reopen}
                    disabled={busy === s.id}
                    onClick={() => void reopen(s.id)}
                  >
                    {busy === s.id ? '恢复中…' : '恢复'}
                  </button>
                ) : (
                  <span className={styles.badgeOpen}>进行中</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
