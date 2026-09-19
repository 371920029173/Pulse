import { useState } from 'react';
import { fetchJSON } from '../lib/api';
import styles from '../styles/Settings.module.css';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

interface Props {
  onClose: () => void;
  activeSessionId?: string | null;
}

const SOURCES = [
  { id: 'raw', label: '原始文本' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'session', label: '当前会话' },
];

export function ImportKnowledge({ onClose, activeSessionId }: Props) {
  // Escape closes this dialog: the backdrop click is a mouse convenience, not a keyboard path.
  useEscapeToClose(onClose);

  const [source, setSource] = useState('raw');
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('paste.txt');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function onFile(file: File) {
    const content = await file.text();
    setText(content);
    setFilename(file.name);
    const lower = file.name.toLowerCase();
    if (lower.includes('cursor')) setSource('cursor');
    else if (lower.includes('claude')) setSource('claude-code');
    else if (lower.includes('codex')) setSource('codex');
  }

  async function submit() {
    setBusy(true);
    setMsg('');
    try {
      const body: Record<string, unknown> = { source, filename };
      if (source === 'session') {
        body.sessionId = activeSessionId || 'active';
      } else {
        body.text = text;
      }
      const res = await fetchJSON<{ ok: boolean; memoriesAdded: number; groupPath: string }>('/api/kb/import', {
        method: 'POST',
        body,
      });
      setMsg(`已导入 ${res.memoriesAdded} 条 → ${res.groupPath}`);
    } catch (e: any) {
      setMsg(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.backdrop} data-surface="backdrop" onClick={onClose}>
      <div className={styles.panel} data-surface="panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <header className={styles.header}>
          <h2>导入知识</h2>
          <button type="button" className={styles.close} onClick={onClose}>Esc</button>
        </header>
        <div className={styles.form}>
          <label>
            <span>来源</span>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {SOURCES.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
          {source !== 'session' && (
            <>
              <label>
                <span>文件（md / txt / json）</span>
                <input
                  type="file"
                  accept=".md,.txt,.json,.jsonl,.markdown"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onFile(f);
                  }}
                />
              </label>
              <label>
                <span>或粘贴内容</span>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={12}
                  placeholder="支持 Markdown / 纯文本 / 聊天 JSON 数组"
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                />
              </label>
            </>
          )}
          {source === 'session' && (
            <p className={styles.hint}>将把当前会话消息切块写入 Group KB（imports/session/日期）。</p>
          )}
          <p className={styles.hint}>
            外挂库建议：留空即用 <code>&lt;工作区&gt;/.she/kb.sqlite</code>。入库走结构组，不是向量 RAG。
          </p>
          <div className={styles.actions}>
            <button type="button" onClick={() => void submit()} disabled={busy || (source !== 'session' && !text.trim())}>
              {busy ? '导入中…' : '导入到知识库'}
            </button>
            {msg ? <span className={styles.hint}>{msg}</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
