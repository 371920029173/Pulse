import { useEffect, useMemo, useRef, useState } from 'react';
import styles from '../styles/CommandPalette.module.css';

export interface CommandItem {
  id: string;
  title: string;
  hint?: string;
  group?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  commands: CommandItem[];
  onClose: () => void;
}

export function CommandPalette({ open, commands, onClose }: Props) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return commands;
    return commands.filter((c) =>
      (c.title + ' ' + (c.hint || '') + ' ' + (c.group || '')).toLowerCase().includes(s),
    );
  }, [commands, q]);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setIdx(0);
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    setIdx(0);
  }, [q]);

  if (!open) return null;

  function runAt(i: number) {
    const item = filtered[i];
    if (!item) return;
    onClose();
    // defer so close animation/state settles
    setTimeout(() => item.run(), 0);
  }

  return (
    <div
      className={styles.backdrop} data-surface="backdrop"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setIdx((v) => Math.min(filtered.length - 1, v + 1));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setIdx((v) => Math.max(0, v - 1));
        } else if (e.key === 'Enter') {
          e.preventDefault();
          runAt(idx);
        }
      }}
    >
      <div className={styles.panel} data-surface="panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className={styles.input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索命令…（Ctrl+K）"
        />
        <div className={styles.list}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>没有匹配的命令</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                type="button"
                className={i === idx ? styles.itemActive : styles.item}
                onMouseEnter={() => setIdx(i)}
                onClick={() => runAt(i)}
              >
                <div className={styles.itemTitle}>{c.title}</div>
                <div className={styles.itemMeta}>
                  {c.group ? <span>{c.group}</span> : null}
                  {c.hint ? <kbd>{c.hint}</kbd> : null}
                </div>
              </button>
            ))
          )}
        </div>
        <div className={styles.footer}>
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
