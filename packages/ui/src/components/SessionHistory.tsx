import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { t } from '../lib/i18n';
import { pathTail } from '../lib/path-label';
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
  /**
   * Which folder this conversation works in.
   *
   * Only meaningful when the list is spanning workspaces (`?scope=all`); in the normal
   * this-workspace-only case every row shares the one path and the column would be noise.
   */
  directory?: string;
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
  if (days < 30) return t('{days} 天前', { days: (days) });
  return d.toISOString().slice(0, 10);
}

/**
 * History: every chat still on disk, including closed ones.
 *
 * Closing hides a session from the working list without losing it; this is
 * where they can be found and reopened. Deleted sessions are gone for good and
 * never appear here.
 *
 * ## Why there is a workspace switch here
 *
 * The session rail lists only the CURRENT workspace, deliberately — a conversation belongs to the
 * project it works in, and mixing projects in the rail means opening the app in one folder shows
 * you another folder's chats. But isolation with no way back out is indistinguishable from
 * deletion: switch workspace and this panel said "N 个对话" while the others were still on disk and
 * unreachable from anywhere in the UI. `/api/conversations?scope=all` existed for exactly that
 * case and nothing called it.
 *
 * So this panel has a second scope, off by default. Off keeps the promise ("this workspace only");
 * on is the escape hatch, and it says so on every row by showing the folder.
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
  /**
   * Show conversations from every workspace this install knows about.
   *
   * Remembered across opens because it answers a question about how the user thinks about their
   * history, not about this one visit — someone who has decided "I want to see everything" should
   * not have to re-decide it every time, and the opposite choice is the default anyway.
   */
  const [allWorkspaces, setAllWorkspaces] = useState<boolean>(() => {
    try { return localStorage.getItem('she.history.allWorkspaces') === '1'; } catch { return false; }
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (allWorkspaces) {
        /*
         * `all=1` includes closed ones (same as the history endpoint) and `scope=all` adds the other
         * known projects. The response is one flat list, so it is split back into open/closed here —
         * the row rendering below only cares about that distinction.
         */
        const d = await fetchJSON<{ sessions?: SessionRow[] }>('/api/sessions?all=1&scope=all');
        const all = d.sessions ?? [];
        setOpen(all.filter((s) => !s.closed));
        setClosed(all.filter((s) => s.closed));
      } else {
        const d = await fetchJSON<{ closed: SessionRow[]; open: SessionRow[] }>('/api/sessions/history');
        setClosed(d.closed ?? []);
        setOpen(d.open ?? []);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [allWorkspaces]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    try { localStorage.setItem('she.history.allWorkspaces', allWorkspaces ? '1' : '0'); } catch { /* ignore */ }
  }, [allWorkspaces]);

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
      toast(t('已恢复该对话'));
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
            <h2 className={styles.title}>{t('历史记录')}</h2>
            <span className={styles.sub}>
              {t('{n} 个对话（含已关闭，不含已删除）', { n: rows.length })}
              {allWorkspaces ? t(' · 全部工作区') : t(' · 仅当前工作区')}
            </span>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>Esc</button>
        </header>

        <div className={styles.toolbar}>
          <input
            className={styles.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('搜索历史对话…')}
            spellCheck={false}
          />
          {/*
             * 范围开关。用 label 包住 checkbox，而不是做成两个按钮：这是一个"要不要多看一点"的
             * 布尔选择，不是二选一的模式切换，checkbox 是原生支持键盘与屏幕阅读器的那一个。
             *
             * 每行都以 `*` 开头不只是排版：i18n 检查逐行扫描，只跳过以 `*` 或 `//` 开头的行，
             * 否则这段散文里的引号内容会被当成一处未翻译文案（这里踩过一次）。
          */}
          <label
            className={styles.scopeToggle}
            title={t('默认只列出当前工作区的对话；打开后连同其他工作区一起列出（不做删除，只是换个范围看）')}
          >
            <input
              type="checkbox"
              checked={allWorkspaces}
              onChange={(e) => setAllWorkspaces(e.target.checked)}
            />
            {t('包含其他工作区')}
          </label>
        </div>

        {error ? <div className={styles.error}>{error}</div> : null}

        <div className={styles.body}>
          {loading ? (
            <div className={styles.empty}>{t('读取中…')}</div>
          ) : rows.length === 0 ? (
            <div className={styles.empty}>
              {query ? t('没有匹配的对话。') : t('还没有任何对话记录。')}
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
                    {/*
                       * 只有在跨工作区时才显示所在目录。一行一个路径在这一列里是必要的噪音——
                       * 用户打开这个开关的原因就是想分清哪些属于别的项目。
                    */}
                    {allWorkspaces && s.directory ? (
                      <span className={styles.folder} title={s.directory}>{pathTail(s.directory)}</span>
                    ) : null}
                    {s.closed ? <span className={styles.tagClosed}>{t('已关闭')}</span> : null}
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
                  <span className={styles.badgeOpen}>{t('进行中')}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
