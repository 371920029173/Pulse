import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import styles from '../styles/Sidebar.module.css';
import { t } from '../lib/i18n';

export interface OutlineSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  preview: string;
  depth?: number;
}

interface Props {
  path: string | null;
  /** Insert @symbol:Name into the composer when a row is clicked. */
  onPickSymbol?: (sym: OutlineSymbol) => void;
}

const KIND_LABEL: Record<string, string> = {
  function: 'fn',
  class: 'class',
  method: 'm',
  interface: 'iface',
  type: 'type',
  const: 'const',
  enum: 'enum',
  other: '·',
};

/**
 * File outline panel — symbols from /api/fs/outline (TS/JS via TypeScript AST).
 */
export function FileOutline({ path, onPickSymbol }: Props) {
  const [symbols, setSymbols] = useState<OutlineSymbol[]>([]);
  const [engine, setEngine] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!path) {
      setSymbols([]);
      setEngine('');
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const data = await fetchJSON<{ symbols: OutlineSymbol[]; engine?: string }>(
        `/api/fs/outline?path=${encodeURIComponent(path)}`,
      );
      setSymbols(data.symbols ?? []);
      setEngine(data.engine ?? '');
    } catch (e) {
      setErr((e as Error).message);
      setSymbols([]);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!path) return null;

  return (
    <div className={styles.treeContainer} style={{ maxHeight: 200 }}>
      <div className={styles.sectionHeader} style={{ paddingLeft: 0 }}>
        <span title={path}>{t('大纲')} · {path.split(/[\\/]/).pop()}</span>
        <button type="button" className={styles.iconBtn} onClick={() => void load()} title={t('刷新大纲')}>
          ↻
        </button>
      </div>
      {engine ? (
        <div className={styles.emptyState} style={{ padding: '2px 8px', fontSize: 11 }}>
          {engine === 'typescript-ast' ? 'TypeScript AST' : t('启发式')}
        </div>
      ) : null}
      {loading ? <div className={styles.emptyState}>{t('解析中…')}</div> : null}
      {err ? <div className={styles.emptyState}>{err}</div> : null}
      {!loading && !err && symbols.length === 0 ? (
        <div className={styles.emptyState}>{t('此文件没有可识别符号')}</div>
      ) : null}
      {symbols.map((s) => (
        <button
          key={`${s.name}:${s.line}:${s.kind}`}
          type="button"
          className={styles.treeNodeRow}
          style={{
            paddingLeft: `${(s.depth ?? 0) * 12 + 8}px`,
            width: '100%',
            textAlign: 'left',
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
          }}
          title={`${s.preview}\nL${s.line}`}
          onClick={() => onPickSymbol?.(s)}
        >
          <span className={styles.treeBadge} style={{ minWidth: 36 }}>
            {KIND_LABEL[s.kind] ?? s.kind}
          </span>
          <span className={styles.treeName}>{s.name}</span>
          <span className={styles.treeBadge}>L{s.line}</span>
        </button>
      ))}
    </div>
  );
}
