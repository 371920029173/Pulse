import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import styles from '../styles/AskCard.module.css';

interface PendingQuestion {
  question: string | null;
  options?: string[];
  context?: string;
  askedAt?: string;
}

/**
 * Renders the agent's pending question.
 *
 * `ask_user` was previously write-only: the agent stored the question and then
 * stopped, but nothing surfaced it, so asking appeared broken. This turns it
 * into a real prompt with clickable options that feed straight back as answers.
 */
export function AskCard({ onAnswer }: { onAnswer: (text: string) => void }) {
  const [q, setQ] = useState<PendingQuestion>({ question: null });
  const [custom, setCustom] = useState('');
  /**
   * Questions already handled in this browser.
   *
   * This used to be plain component state, so a reload forgot it and the card
   * came straight back. Persist per-question (keyed by `askedAt`) so a refresh
   * never resurrects something the user already answered or dismissed.
   */
  const DISMISSED_KEY = 'she.ask.dismissed';
  const readDismissed = (): string[] => {
    try {
      const raw = localStorage.getItem(DISMISSED_KEY);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(arr) ? (arr as string[]) : [];
    } catch {
      return [];
    }
  };
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);

  const load = useCallback(async () => {
    try {
      const d = await fetchJSON<PendingQuestion>('/api/ask/pending');
      setQ(d);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(t);
  }, [load]);

  /** Remember this question as handled, locally and on the server. */
  const forget = useCallback((key: string) => {
    setDismissed((prev) => {
      const next = [...new Set([...prev, key])].slice(-50);
      try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
    // Clear server-side too, so other windows and future reloads agree.
    void fetchJSON('/api/ask/pending', { method: 'DELETE' }).catch(() => undefined);
  }, []);

  // Identify the question by when it was asked; fall back to its text.
  const qKey = q.askedAt || q.question || '';
  if (!q.question || dismissed.includes(qKey)) return null;

  const answer = (text: string) => {
    const value = text.trim();
    if (!value) return;
    setCustom('');
    forget(qKey);
    onAnswer(value);
  };

  return (
    <div className={styles.card} data-surface="card">
      <div className={styles.head}>
        <span className={styles.icon}>?</span>
        <span className={styles.label}>智能体需要你确认</span>
      </div>

      {q.context ? <div className={styles.context}>{q.context}</div> : null}
      <div className={styles.question}>{q.question}</div>

      {q.options && q.options.length > 0 ? (
        <div className={styles.options}>
          {q.options.map((o) => (
            <button key={o} type="button" className={styles.option} onClick={() => answer(o)}>
              {o}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.freeRow}>
        <input
          className={styles.input}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="或直接输入你的回答…"
          onKeyDown={(e) => { if (e.key === 'Enter') answer(custom); }}
        />
        <button
          type="button"
          className={styles.send}
          disabled={!custom.trim()}
          onClick={() => answer(custom)}
        >回答</button>
        {/* Without this there was no way to get rid of the card except by
            answering it — and it came back on every reload anyway. */}
        <button
          type="button"
          className={styles.dismiss}
          title="忽略这个问题（不再显示）"
          onClick={() => forget(qKey)}
        >忽略</button>
      </div>
    </div>
  );
}
