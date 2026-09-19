import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { toast } from '../lib/toast';
import { t } from '../lib/i18n';
import styles from '../styles/ImportSources.module.css';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

interface Conversation {
  id: string;
  source: 'cursor' | 'claude-code' | 'codex';
  title: string;
  project?: string;
  path: string;
  messageCount: number;
  updatedAt?: string;
  sizeBytes: number;
}

interface SourceBlock {
  id: string;
  label: string;
  root: string;
  found: boolean;
  note?: string;
  conversations: Conversation[];
}

interface Props {
  onClose: () => void;
  /** Where to send the selected conversations. */
  destination?: 'sessions' | 'kb';
  /** Called after a successful migration so the chat can reload its history. */
  onImported?: () => void;
}

const SOURCE_COLOR: Record<string, string> = {
  cursor: '215',
  'claude-code': '25',
  codex: '160',
};

const SOURCE_ICON: Record<string, string> = {
  cursor: '◈',
  'claude-code': '❋',
  codex: '⊞',
};

function fmtSize(b: number): string {
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  if (b > 1024) return `${Math.round(b / 1024)}KB`;
  return `${b}B`;
}

function fmtWhen(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return t('今天');
  if (days === 1) return t('昨天');
  if (days < 30) return t('{n} 天前', { n: days });
  return d.toISOString().slice(0, 10);
}

/**
 * Import existing Cursor / Claude Code / Codex conversations.
 *
 * Scans the machine for where those tools keep their history and lists what is
 * available, rather than asking the user to paste or hunt for files.
 */
export function ImportSources({ onClose, destination = 'sessions', onImported }: Props) {
  // Escape closes this dialog: the backdrop click is a mouse convenience, not a keyboard path.
  useEscapeToClose(onClose);

  const [dest, setDest] = useState<'sessions' | 'kb'>(destination);
  const [sources, setSources] = useState<SourceBlock[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJSON<{ sources: SourceBlock[] }>('/api/import/discover');
      setSources(data.sources ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void scan(); }, [scan]);

  const allItemIds = useMemo(
    () =>
      sources
        .flatMap((s) => s.conversations)
        .filter((c) => !filter || c.title.toLowerCase().includes(filter.toLowerCase()) || (c.project ?? '').toLowerCase().includes(filter.toLowerCase()))
        .map((c) => c.id),
    [sources, filter],
  );

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === allItemIds.length ? new Set() : new Set(allItemIds)));
  };

  const doImport = useCallback(async () => {
    if (!selected.size) return;
    setImporting(true);
    setError(null);
    try {
      const r = await fetchJSON<{
        imported: number;
        memoriesAdded?: number;
        skipped: string[];
        chars?: number;
        truncatedConversations?: number;
      }>('/api/import/from-source', {
        method: 'POST',
        body: { ids: [...selected], destination: dest },
      });
      if (dest === 'sessions') {
        // Say what actually happened: these are now openable conversations, not file references.
        const extra = r.truncatedConversations
          ? t('（{n} 段过长，只保留了前 500 轮）', { n: r.truncatedConversations })
          : '';
        toast(t('已移植 {n} 段对话记录{extra}', { n: r.imported, extra }));
        if (r.skipped?.length) {
          toast(t('{n} 段无法解析，已跳过：{first}', { n: r.skipped.length, first: r.skipped[0] ?? '' }));
        }
        onImported?.();
      } else {
        toast(t('已导入 {n} 个对话（{k} 条知识）', { n: r.imported, k: r.memoriesAdded ?? 0 }));
        onImported?.();
      }
      setSelected(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }, [selected, dest, onImported]);

  

  return (
    <div className={styles.backdrop} data-surface="backdrop" onClick={onClose}>
      <div className={styles.panel} data-surface="panel" onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>{t('导入对话记录')}</h2>
            <p className={styles.sub}>
              扫描本机的 Cursor / Claude Code / Codex 记录；默认<b>移植为对话记录</b>：原件会复制到 <code>.she/imports/</code> 留底，同时生成可直接打开、接着往下聊的对话。
            </p>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>Esc</button>
        </header>

        <div className={styles.toolbar}>
          <input
            className={styles.filter}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('筛选对话标题或项目…')}
            spellCheck={false}
          />
          <button type="button" className={styles.ghost} onClick={() => void scan()} disabled={loading}>
            {loading ? t('扫描中…') : t('重新扫描')}
          </button>
          <button type="button" className={styles.ghost} onClick={toggleAll} disabled={!allItemIds.length}>
            {selected.size === allItemIds.length && allItemIds.length > 0 ? t('取消全选') : t('全选')}
          </button>
        </div>

        {error ? <div className={styles.error}>{error}</div> : null}

        <div className={styles.body}>
          {loading ? (
            <div className={styles.loading}>{t('正在扫描本机记录…')}</div>
          ) : (
            sources.map((s) => {
              const visible = s.conversations.filter(
                (c) =>
                  !filter ||
                  c.title.toLowerCase().includes(filter.toLowerCase()) ||
                  (c.project ?? '').toLowerCase().includes(filter.toLowerCase()),
              );
              return (
                <section key={s.id} className={styles.sourceBlock}>
                  <div className={styles.sourceHead}>
                    <span
                      className={styles.sourceIcon}
                      style={{ ['--h' as string]: SOURCE_COLOR[s.id] ?? '215' }}
                    >
                      {SOURCE_ICON[s.id] ?? '◈'}
                    </span>
                    <span className={styles.sourceLabel}>{s.label}</span>
                    <span className={styles.sourceCount}>
                      {s.found ? t('{n} 个对话', { n: visible.length }) : t('未找到')}
                    </span>
                    <span className={styles.sourceRoot} title={s.root}>{s.root}</span>
                  </div>

                  {s.note ? <div className={styles.sourceNote}>{s.note}</div> : null}

                  {visible.length === 0 && s.found ? (
                    <div className={styles.sourceNote}>{t('没有可导入的对话。')}</div>
                  ) : null}

                  <div className={styles.items}>
                    {visible.slice(0, 200).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className={`${styles.item} ${selected.has(c.id) ? styles.itemOn : ''}`}
                        onClick={() => toggle(c.id)}
                        title={c.path}
                      >
                        <span className={styles.check}>{selected.has(c.id) ? '✓' : ''}</span>
                        <span className={styles.itemMain}>
                          <span className={styles.itemTitle}>{c.title || t('未命名对话')}</span>
                          {c.project ? <span className={styles.itemProject}>{c.project}</span> : null}
                        </span>
                        <span className={styles.itemMeta}>
                          {c.messageCount} 条 · {fmtSize(c.sizeBytes)}
                          {c.updatedAt ? ` · ${fmtWhen(c.updatedAt)}` : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>

        <footer className={styles.footer}>
          <span className={styles.selCount}>{t('已选 {n} 个', { n: selected.size })}</span>
          <div className={styles.destRow}>
            <label className={styles.destOpt}>
              <input
                type="radio"
                checked={dest === 'sessions'}
                onChange={() => setDest('sessions')}
              />
              <span>{t('移植为对话记录')}</span>
            </label>
            <label className={styles.destOpt}>
              <input
                type="radio"
                checked={dest === 'kb'}
                onChange={() => setDest('kb')}
              />
              <span>{t('写入知识库')}</span>
            </label>
          </div>
          {/*
            One button, on purpose.
            There was a second, louder "一键全部导入(n)" beside this one. Two primary actions in the
            same footer made the deliberate path (select, then import) look like the slow way, and
            bulk-importing every conversation on the machine is not something to make the easiest
            click on the screen. "全选" in the toolbar already covers the bulk case in one extra
            step, and it shows what is about to be imported before it happens.
          */}
          <button
            type="button"
            className={styles.ghost}
            disabled={importing || selected.size === 0}
            onClick={() => void doImport()}
          >
            {importing ? t('导入中…') : t('导入选中({n})', { n: selected.size })}
          </button>
        </footer>
      </div>
    </div>
  );
}
