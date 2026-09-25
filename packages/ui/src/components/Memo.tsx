import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJSON } from '../lib/api';
import { t } from '../lib/i18n';
import styles from '../styles/Memo.module.css';

interface MemoEntry {
  id: string;
  text: string;
  author: 'user' | 'agent';
  done: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Shared scratchpad. Both the user (here) and the agent (memo_* tools) write to
 * the same file, so edits from either side show up on refresh/poll.
 */
export function Memo({ compact = false }: { compact?: boolean }) {
  const [entries, setEntries] = useState<MemoEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  /**
   * Completed items are shown by default.
   *
   * They used to be hidden, and the result was that the agent's finished work disappeared from the
   * one place the user could see it — a memo is a *record* of what both sides noted, not a todo
   * list that is done with an item once it is ticked. Measured against a live run: the agent had
   * recorded items, marked them done, and the panel showed an empty list, which reads as "it never
   * wrote anything". The toggle still folds them away for anyone who wants the short view.
   */
  const [showDone, setShowDone] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchJSON<{ entries: MemoEntry[] }>('/api/memo');
      setEntries(data.entries ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    /*
     * The agent may write while we sit here; keep it fresh.
     *
     * Named `timer`, not `t`: this component now calls the i18n `t()`, and a local `t` here would
     * shadow it for anything added to this callback later — a confusing failure that TypeScript
     * would catch only if the shadowed usage happened to type-check.
     */
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [load]);

  const add = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    try {
      await fetchJSON('/api/memo', { method: 'POST', body: { text } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [draft, load]);

  const toggle = useCallback(async (m: MemoEntry) => {
    await fetchJSON(`/api/memo/${m.id}`, { method: 'PUT', body: { done: !m.done } });
    await load();
  }, [load]);

  const saveEdit = useCallback(async () => {
    if (!editingId) return;
    const text = editingText.trim();
    setEditingId(null);
    if (!text) return;
    await fetchJSON(`/api/memo/${editingId}`, { method: 'PUT', body: { text } });
    await load();
  }, [editingId, editingText, load]);

  const remove = useCallback(async (id: string) => {
    await fetchJSON(`/api/memo/${id}`, { method: 'DELETE' });
    await load();
  }, [load]);

  const visible = showDone ? entries : entries.filter((m) => !m.done);
  const doneCount = entries.filter((m) => m.done).length;
  /**
   * Two different states, two different sentences.
   *
   * "还没有记录" was shown whenever the *visible* list came out empty, so a scratchpad holding
   * nothing but completed items claimed to be untouched — the one message that makes a user
   * conclude the agent never wrote anything. An empty view has to say which kind of empty it is.
   */
  const emptyMessage = entries.length === 0
    ? t('还没有记录。你和智能体都可以往这里写。')
    : t('{n} 条已完成被折叠了，点右上角「显示完成」展开。', { n: doneCount });

  return (
    <div className={`${styles.wrap} ${compact ? styles.compact : ''}`}>
      <div className={styles.head}>
        <span className={styles.headTitle}>{t('备忘录')}</span>
        <span className={styles.headMeta}>
          {t('{n} 待办', { n: entries.length - doneCount })}
          {doneCount ? ` · ${t('{n} 已完成', { n: doneCount })}` : ''}
        </span>
        <button
          type="button"
          className={styles.headBtn}
          onClick={() => setShowDone((v) => !v)}
          title={showDone ? t('隐藏已完成') : t('显示已完成')}
        >
          {showDone ? t('隐藏完成') : t('显示完成')}
        </button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.addRow}>
        <input
          ref={inputRef}
          className={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
          placeholder={t('记一条灵感或待办…（回车添加）')}
        />
        <button type="button" className={styles.addBtn} disabled={!draft.trim()} onClick={() => void add()}>+</button>
      </div>

      <div className={styles.list}>
        {visible.length === 0 ? (
          <div className={styles.empty}>{emptyMessage}</div>
        ) : (
          visible.map((m) => (
            <div key={m.id} className={`${styles.item} ${m.done ? styles.itemDone : ''}`}>
              <button
                type="button"
                className={styles.check}
                onClick={() => void toggle(m)}
                title={m.done ? t('标为未完成') : t('标为完成')}
              >
                {m.done ? '✓' : ''}
              </button>

              {editingId === m.id ? (
                <input
                  className={styles.editInput}
                  value={editingText}
                  autoFocus
                  onChange={(e) => setEditingText(e.target.value)}
                  onBlur={() => void saveEdit()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveEdit();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <span
                  className={styles.text}
                  onClick={() => { setEditingId(m.id); setEditingText(m.text); }}
                  title={t('单击编辑')}
                >
                  {m.text}
                </span>
              )}

              <span className={`${styles.who} ${m.author === 'agent' ? styles.whoAgent : ''}`}>
                {m.author === 'user' ? t('我') : 'AI'}
              </span>
              <button type="button" className={styles.del} onClick={() => void remove(m.id)} title={t('删除')}>×</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
