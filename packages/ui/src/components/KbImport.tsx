import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import styles from '../styles/Settings.module.css';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

interface SessionRow {
  id: string;
  title: string;
}

interface Props {
  onClose: () => void;
}

const SOURCES = [
  { id: 'raw', label: '粘贴 / 文件' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'session', label: '本机会话' },
] as const;

export function KbImport({ onClose }: Props) {
  // Escape closes this dialog: the backdrop click is a mouse convenience, not a keyboard path.
  useEscapeToClose(onClose);

  const [mode, setMode] = useState<'path' | 'paste'>('path');
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [filename, setFilename] = useState('paste.md');
  const [source, setSource] = useState<string>('raw');
  const [sessionId, setSessionId] = useState('');
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetchJSON<{ sessions: SessionRow[] }>('/api/sessions')
      .then((d) => setSessions(d.sessions || []))
      .catch(() => undefined);
  }, []);

  /**
   * Import by path. A folder path means "absorb everything inside it" — the
   * server walks it and files each piece under imports/<label>/<date> with the
   * source recorded in the node title.
   */
  async function submitPath() {
    const p = path.trim().replace(/^["']|["']$/g, '');
    if (!p) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetchJSON<{
        kind: string;
        groupPath: string;
        memoriesAdded: number;
        origin: string;
      }>('/api/kb/import-path', {
        method: 'POST',
        body: { path: p, label: label.trim() || undefined },
      });
      setMsg(
        `已导入 ${res.memoriesAdded} 条（${res.kind === 'directory' ? '文件夹' : '文件'}）→ ${res.groupPath}`,
      );
      setPath('');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const onFile = useCallback(async (file: File | null) => {
    if (!file) return;
    setFilename(file.name);
    const lower = file.name.toLowerCase();
    if (!(lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.json') || lower.endsWith('.jsonl'))) {
      setMsg('建议 md / txt / json / jsonl');
    }
    setText(await file.text());
  }, []);

  async function submit() {
    setBusy(true);
    setMsg('');
    try {
      const body: Record<string, unknown> = {
        source: source === 'session' ? 'session' : source,
        filename,
      };
      if (source === 'session') {
        body.sessionId = sessionId || 'active';
      } else {
        body.text = text;
      }
      const res = await fetchJSON<{ ok: boolean; memoriesAdded: number; groupPath: string }>('/api/kb/import', {
        method: 'POST',
        body,
      });
      setMsg(`已写入 ${res.memoriesAdded} 条 → ${res.groupPath}`);
      setText('');
    } catch (e: any) {
      setMsg(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.backdrop} data-surface="backdrop" onClick={onClose}>
      <div className={styles.panel} data-surface="panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <header className={styles.header}>
          <h2>导入知识库</h2>
          <button type="button" className={styles.close} onClick={onClose}>Esc</button>
        </header>

        <div className={styles.tabs} style={{ display: 'flex', gap: 6, padding: '0 16px 10px' }}>
          <button
            type="button"
            className={styles.close}
            style={{ opacity: mode === 'path' ? 1 : 0.55 }}
            onClick={() => setMode('path')}
          >粘贴地址</button>
          <button
            type="button"
            className={styles.close}
            style={{ opacity: mode === 'paste' ? 1 : 0.55 }}
            onClick={() => setMode('paste')}
          >粘贴内容</button>
        </div>

        {mode === 'path' ? (
          <div className={styles.form}>
            <p className={styles.hint}>
              粘贴文件或<b>文件夹</b>的绝对路径。粘贴文件夹意味着把它里面的东西全部导入。
              写入 <code>imports/标签/日期</code>，每条知识的名字都会带上来源。
            </p>
            <label>
              <span>路径</span>
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="例如 ~/notes 或 ~/notes/spec.md"
                spellCheck={false}
                style={{ fontFamily: 'ui-monospace, monospace' }}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitPath(); }}
              />
            </label>
            <label>
              <span>来源标签（选填）</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="默认用文件夹名"
              />
            </label>
            <div className={styles.actions}>
              <button type="button" onClick={() => void submitPath()} disabled={busy || !path.trim()}>
                {busy ? '导入中…' : '导入'}
              </button>
              {msg ? <span className={styles.hint}>{msg}</span> : null}
            </div>
          </div>
        ) : (
        <div className={styles.form}>
          <p className={styles.hint}>
            支持 md / txt / json（含 Cursor / Claude / Codex 导出）。写入外挂库分组 <code>imports/来源/日期</code>。
          </p>
          <label>
            <span>来源标签</span>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {SOURCES.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          </label>
          {source === 'session' ? (
            <label>
              <span>会话</span>
              <select value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
                <option value="">当前活动会话</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>{s.title || s.id}</option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label>
                <span>选择文件</span>
                <input
                  type="file"
                  accept=".md,.txt,.json,.jsonl,text/plain,application/json"
                  onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
                />
              </label>
              <label>
                <span>或粘贴内容</span>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={12}
                  spellCheck={false}
                  placeholder="粘贴对话记录 / Markdown / JSON…"
                  style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                />
              </label>
            </>
          )}
          <div className={styles.actions}>
            <button type="button" onClick={() => void submit()} disabled={busy}>
              {busy ? '导入中…' : '写入知识库'}
            </button>
            {msg ? <span className={styles.hint}>{msg}</span> : null}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
