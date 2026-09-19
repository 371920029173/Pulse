import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJSON } from '../lib/api';
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
  const [showDone, setShowDone] = useState(false);
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
    // The agent may write while we sit here; keep it fresh.
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
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

  return (
    <div className={`${styles.wrap} ${compact ? styles.compact : ''}`}>
      <div className={styles.head}>
        <span className={styles.headTitle}>备忘录</span>
        <span className={styles.headMeta}>
          {entries.length - doneCount} 待办{doneCount ? ` · ${doneCount} 已完成` : ''}
        </span>
        <button
          type="button"
          className={styles.headBtn}
          onClick={() => setShowDone((v) => !v)}
          title={showDone ? '隐藏已完成' : '显示已完成'}
        >
          {showDone ? '隐藏完成' : '显示完成'}
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
          placeholder="记一条灵感或待办…（回车添加）"
        />
        <button type="button" className={styles.addBtn} disabled={!draft.trim()} onClick={() => void add()}>+</button>
      </div>

      <div className={styles.list}>
        {visible.length === 0 ? (
          <div className={styles.empty}>还没有记录。你和智能体都可以往这里写。</div>
        ) : (
          visible.map((m) => (
            <div key={m.id} className={`${styles.item} ${m.done ? styles.itemDone : ''}`}>
              <button
                type="button"
                className={styles.check}
                onClick={() => void toggle(m)}
                title={m.done ? '标为未完成' : '标为完成'}
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
                  title="单击编辑"
                >
                  {m.text}
                </span>
              )}

              <span className={`${styles.who} ${m.author === 'agent' ? styles.whoAgent : ''}`}>
                {m.author === 'user' ? '我' : 'AI'}
              </span>
              <button type="button" className={styles.del} onClick={() => void remove(m.id)} title="删除">×</button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
