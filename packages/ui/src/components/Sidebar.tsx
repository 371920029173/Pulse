import React, { useState, useCallback } from 'react';
import type { GroupTreeNode } from '../hooks/useKB';
import styles from '../styles/Sidebar.module.css';

interface SidebarProps {
  tree: GroupTreeNode[];
  onGroupClick: (id: string) => void;
  onNewSession?: () => void;
}

interface TreeNodeProps {
  node: GroupTreeNode;
  depth: number;
  onGroupClick: (id: string) => void;
}

function TreeNode({ node, depth, onGroupClick }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children.length > 0;

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasChildren) setExpanded((v) => !v);
  }, [hasChildren]);

  const handleClick = useCallback(() => {
    onGroupClick(node.id);
  }, [node.id, onGroupClick]);

  return (
    <div className={styles.treeNode}>
      <div
        className={`${styles.treeNodeRow} ${node.isDormant ? styles.treeNodeDormant : ''}`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={handleClick}
      >
        <span
          className={`${styles.treeChevron} ${expanded ? styles.treeChevronExpanded : ''} ${!hasChildren ? styles.treeChevronHidden : ''}`}
          onClick={handleToggle}
        >
          ›
        </span>
        <span className={styles.treeName}>{node.name}</span>
        <span className={styles.treeBadge}>{node.memoryCount}</span>
      </div>
      {expanded && hasChildren && (
        <div className={styles.treeChildren}>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              onGroupClick={onGroupClick}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ tree, onGroupClick, onNewSession }: SidebarProps) {
  return (
    <div className={styles.sidebar}>
      <div className={styles.logo}>
        <div className={styles.logoIcon}>S</div>
        <span className={styles.logoText}>SHE</span>
        <span className={styles.logoVersion}>v2</span>
      </div>

      <div className={styles.sectionHeader}>
        <span>Sessions</span>
        <button className={styles.sectionAction} onClick={onNewSession} title="New session">
          +
        </button>
      </div>
      <div className={styles.sessionList}>
        <div className={`${styles.sessionItem} ${styles.sessionItemActive}`}>
          <span className={styles.sessionDot} />
          Session 1
        </div>
      </div>

      <div className={styles.divider} />

      <div className={styles.sectionHeader}>
        <span>Knowledge Base</span>
      </div>
      <div className={styles.treeContainer}>
        {tree.length === 0 ? (
          <div className={styles.emptyState}>
            No groups yet.<br />Ingest files to populate the KB.
          </div>
        ) : (
          tree.map((node) => (
            <TreeNode
              key={node.id}
              node={node}
              depth={0}
              onGroupClick={onGroupClick}
            />
          ))
        )}
      </div>
    </div>
  );
}
