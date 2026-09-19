import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
import styles from '../styles/Sidebar.module.css';
import { IconRefresh } from './Icons';

export interface FsNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FsNode[];
}

interface FileTreeProps {
  onOpenFile?: (path: string, content: string) => void;
}

function FsRow({
  node,
  depth,
  onOpenFile,
}: {
  node: FsNode;
  depth: number;
  onOpenFile?: (path: string, content: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const [children, setChildren] = useState<FsNode[] | undefined>(node.children);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.type !== 'dir') return;
    if (!expanded && (!children || children.length === 0)) {
      setLoading(true);
      try {
        const data = await fetchJSON<{ tree: FsNode[] }>(`/api/fs/tree?path=${encodeURIComponent(node.path)}&depth=1`);
        setChildren(data.tree);
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
    setExpanded((v) => !v);
  }, [expanded, children, node]);

  const open = useCallback(async () => {
    if (node.type === 'dir') {
      await toggle({ stopPropagation() {} } as React.MouseEvent);
      return;
    }
    try {
      const data = await fetchJSON<{ path: string; content: string }>(`/api/fs/read?path=${encodeURIComponent(node.path)}`);
      onOpenFile?.(data.path, data.content);
    } catch (e) {
      onOpenFile?.(node.path, `Error: ${(e as Error).message}`);
    }
  }, [node, onOpenFile, toggle]);

  return (
    <div>
      <div
        className={styles.treeNodeRow}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={open}
        title={node.path}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', node.path);
          e.dataTransfer.effectAllowed = 'copy';
        }}
      >
        <span
          className={`${styles.treeChevron} ${expanded ? styles.treeChevronExpanded : ''} ${node.type !== 'dir' ? styles.treeChevronHidden : ''}`}
          onClick={toggle}
        >
          ▸
        </span>
        <span className={styles.treeName}>{node.type === 'dir' ? '📁' : '📄'} {node.name}</span>
        {loading && <span className={styles.treeBadge}>…</span>}
      </div>
      {expanded && node.type === 'dir' && (children?.length ?? 0) > 0 && (
        <div className={styles.treeChildren}>
          {children!.map((c) => (
            <FsRow key={c.path} node={c} depth={depth + 1} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileTree({ onOpenFile }: FileTreeProps) {
  const [tree, setTree] = useState<FsNode[]>([]);
  const [root, setRoot] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchJSON<{ root: string; tree: FsNode[] }>('/api/fs/tree?path=.&depth=2');
      setTree(data.tree);
      setRoot(data.root);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  return (
    <div className={styles.treeContainer} style={{ maxHeight: 220 }}>
      <div className={styles.sectionHeader} style={{ paddingLeft: 0 }}>
        <span title={root}>文件</span>
        <button type="button" className={styles.iconBtn} onClick={refresh} title="刷新">
          <IconRefresh size={15} />
        </button>
      </div>
      {err && <div className={styles.emptyState}>{err}</div>}
      {!err && tree.length === 0 && <div className={styles.emptyState}>工作区为空</div>}
      {tree.map((n) => (
        <FsRow key={n.path} node={n} depth={0} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}
