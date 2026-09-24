import React, { useState, useCallback, useEffect } from 'react';
import type { GroupTreeNode } from '../hooks/useKB';
import styles from '../styles/Sidebar.module.css';
import { McpPanel } from './McpPanel';
import { FileTree } from './FileTree';
import { FileOutline } from './FileOutline';
import {
  IconPlus, IconClose, IconHistory, IconSettings, IconTrash, IconWindows, IconDownload,
  IconChevronDown, IconChevronRight, IconMerge,
} from './Icons';
import { t } from '../lib/i18n';

export interface SessionMeta {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** 'chat' for normal conversations, 'cluster' for work groups. */
  kind?: 'chat' | 'cluster';
  memberCount?: number;
  status?: string;
  /** Project directory this chat works in. */
  directory?: string;
  /** Set when another conversation started this one. */
  parent_id?: string;
  background?: boolean;
  /** True while this conversation still has a turn in flight. */
  running?: boolean;
}

interface SidebarProps {
  tree: GroupTreeNode[];
  sessions: SessionMeta[];
  activeSessionId: string | null;
  onOpenSettings?: () => void;
  onOpenFile?: (path: string, content: string) => void;
  /** Opens Settings at the shared / merged knowledge base block. */
  onOpenKbSharing?: () => void;
  /** Insert text into the chat composer (e.g. @symbol:Name). */
  onInsertText?: (text: string) => void;
  onGroupClick: (id: string) => void;
  onNewSession?: () => void;
  onSelectSession?: (id: string) => void;
  onDeleteSession?: (id: string) => void;
  /** Hide a session but keep it recoverable in history. */
  onCloseSession?: (id: string) => void;
  /** Open the history panel (all chats except deleted ones). */
  onOpenHistory?: () => void;
  /** Return to the home / workspace picker page. */
  onGoHome?: () => void;
  onExportSession?: (id: string) => void;
  onRenameSession?: (id: string, title: string) => void;
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
          ▸
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

export function Sidebar({
  tree,
  sessions,
  activeSessionId,
  onGroupClick,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onCloseSession,
  onOpenHistory,
  onGoHome,
  onExportSession,
  onRenameSession,
  onOpenSettings,
  onOpenFile,
  onOpenKbSharing,
  onInsertText,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [sessionQuery, setSessionQuery] = useState('');
  /**
   * Sessions beyond this many are folded away.
   *
   * A long-running workspace accumulates dozens of chats, and the list pushed
   * the MCP and knowledge sections off screen. Show the recent few by default;
   * searching always shows every match.
   */
  const COLLAPSED_COUNT = 5;
  const [showAllSessions, setShowAllSessions] = useState(false);
  /** Session awaiting delete confirmation (see the 🗑 button). */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  /**
   * Section visibility, persisted so a collapsed sidebar layout is remembered.
   * With everything expanded at once the column was unreadable — three panels
   * competing for one screen.
   */
  const [showMcp, setShowMcp] = useState(() => localStorage.getItem('she.side.mcp') !== '0');
  const [showKb, setShowKb] = useState(() => localStorage.getItem('she.side.kb') !== '0');
  const [showFiles, setShowFiles] = useState(() => localStorage.getItem('she.side.files') !== '0');
  const [outlinePath, setOutlinePath] = useState<string | null>(null);
  useEffect(() => { localStorage.setItem('she.side.mcp', showMcp ? '1' : '0'); }, [showMcp]);
  useEffect(() => { localStorage.setItem('she.side.kb', showKb ? '1' : '0'); }, [showKb]);
  useEffect(() => { localStorage.setItem('she.side.files', showFiles ? '1' : '0'); }, [showFiles]);
  const q = sessionQuery.trim().toLowerCase();
  const visibleSessions = !q
    ? sessions
    : sessions.filter((x) => x.title.toLowerCase().includes(q) || x.id.toLowerCase().includes(q));
  const foldedCount = visibleSessions.length - COLLAPSED_COUNT;
  const isFolded = !q && !showAllSessions && foldedCount > 0;
  const renderedSessions = isFolded ? visibleSessions.slice(0, COLLAPSED_COUNT) : visibleSessions;

  return (
    <div className={styles.sidebar}>
      <div className={styles.logo}>
        {/* Clicking the mark returns to the home / workspace picker page. */}
        <button
          type="button"
          className={styles.logoHome}
          onClick={onGoHome}
          title="回到主页"
        >
          <span className={styles.logoIcon} aria-hidden><span className={styles.logoPulse} /></span>
          <span className={styles.logoText}>bot</span>
        </button>
        <span className={styles.logoVersion}>v2</span>
        {/* Desktop only: open another independent window (own conversation). */}
        {window.sheDesktop?.isDesktop ? (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => { void window.sheDesktop?.newWindow(); }}
            title="新建窗口（Ctrl+Shift+N）— 独立会话，可与本窗口并列"
          >
            <IconWindows size={15} />
          </button>
        ) : null}
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onOpenSettings}
          title="设置"
        >
          <IconSettings size={15} />
        </button>
      </div>

      <div className={styles.sectionHeader}>
        <span>会话</span>
        <div className={styles.sectionActions}>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onOpenHistory}
            title="历史记录（含已关闭的对话）"
          >
            <IconHistory size={15} />
          </button>
          <button type="button" className={styles.iconBtn} onClick={onNewSession} title="新建会话">
            <IconPlus size={15} />
          </button>
        </div>
      </div>
      {sessions.length > 0 ? (
        <div className={styles.sessionFilterWrap}>
          <input
            className={styles.sessionFilter}
            value={sessionQuery}
            onChange={(e) => setSessionQuery(e.target.value)}
            placeholder="筛选会话…"
            aria-label="筛选会话"
          />
        </div>
      ) : null}
      <div className={styles.sessionList}>
        {sessions.length === 0 ? (
          <div className={styles.emptyState}>暂无会话</div>
        ) : visibleSessions.length === 0 ? (
          <div className={styles.emptyState}>无匹配会话</div>
        ) : (
          renderedSessions.map((s, i) => (
            <div
              key={s.id}
              style={{ ['--i' as string]: i } as React.CSSProperties}
              className={`${styles.sessionItem} ${s.id === activeSessionId ? styles.sessionItemActive : ''}`}
              onClick={() => { setPendingDeleteId(null); onSelectSession?.(s.id); }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSelectSession?.(s.id);
              }}
            >
              {/*
                The dot reflects this chat's state. It previously never changed,
                so switching sessions left a stale-looking marker that read as
                "the icon didn't refresh".
              */}
              <span
                className={`${styles.sessionDot} ${
                  s.kind === 'cluster'
                    ? styles.sessionDotGroup
                    : s.id === activeSessionId
                      ? styles.sessionDotActive
                      : styles.sessionDotIdle
                }`}
                title={s.kind === 'cluster' ? '讨论群' : s.id === activeSessionId ? '当前会话' : '普通会话'}
              />
              {editingId === s.id ? (
                <input
                  className={styles.renameInput}
                  value={editingTitle}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onBlur={() => {
                    const t = editingTitle.trim();
                    if (t && t !== s.title) onRenameSession?.(s.id, t);
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <>
                  {s.kind === 'cluster' ? <span className={styles.groupBadge}>{t('群')}</span> : null}
                  {s.parent_id ? <span className={styles.groupBadge}>{t('子')}</span> : null}
                  <span
                    style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      if (s.kind === 'cluster') return;
                      setEditingId(s.id);
                      setEditingTitle(s.title);
                    }}
                    title={
                      s.kind === 'cluster'
                        ? t('工作群 · {n} 名成员', { n: s.memberCount ?? 0 })
                        : [s.directory, s.parent_id ? t('由 {id} 发起', { id: s.parent_id }) : '', t('双击重命名')].filter(Boolean).join('\n')
                    }
                  >
                    {s.title}
                    {s.kind !== 'cluster' && s.directory ? (
                      <span style={{ opacity: 0.55, marginLeft: 6, fontSize: 10 }}>
                        {s.directory.split(/[/\\]/).filter(Boolean).slice(-1)[0]}
                        {s.running ? t(' · 进行中') : ''}
                        {s.background ? t(' · 后台') : ''}
                      </span>
                    ) : null}
                  </span>
                </>
              )}
              {/*
                Permanent deletion is a two-step action.
                It used to fire on a single click of a small 🗑 sitting right
                next to × — so a miss-click silently destroyed a conversation
                with no undo. Now the row asks first.
              */}
              {pendingDeleteId === s.id ? (
                <>
                  <button
                    type="button"
                    className="she-btn she-btn--sm she-btn--danger"
                    title="确认永久删除这条会话"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDeleteId(null);
                      onDeleteSession?.(s.id);
                    }}
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    className="she-btn she-btn--sm"
                    title="取消"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDeleteId(null);
                    }}
                  >
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={styles.rowAction}
                    title="导出 Markdown"
                    onClick={(e) => {
                      e.stopPropagation();
                      onExportSession?.(s.id);
                    }}
                  >
                    <IconDownload size={14} />
                  </button>
                  <button
                    type="button"
                    className={styles.rowAction}
                    title="关闭（保留在历史记录里）"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseSession?.(s.id);
                    }}
                  >
                    <IconClose size={14} />
                  </button>
                  <button
                    type="button"
                    className={`${styles.rowAction} ${styles.rowActionDanger}`}
                    title="删除（不可恢复，会先让你确认）"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDeleteId(s.id);
                    }}
                  >
                    <IconTrash size={14} />
                  </button>
                </>
              )}
            </div>
          ))
        )}
        {/* Fold the tail of a long session list so the panels below stay reachable. */}
        {isFolded ? (
          <button
            type="button"
            className={styles.foldToggle}
            onClick={() => setShowAllSessions(true)}
            title={`还有 ${foldedCount} 条较早的会话`}
          >
            显示更早的 {foldedCount} 条 ▾
          </button>
        ) : !q && showAllSessions && foldedCount > 0 ? (
          <button
            type="button"
            className={styles.foldToggle}
            onClick={() => setShowAllSessions(false)}
            title="只显示最近的会话"
          >
            只显示最近 {COLLAPSED_COUNT} 条 ▴
          </button>
        ) : null}
      </div>

      <div className={styles.divider} />

      <button
        type="button"
        className={styles.collapseHeader}
        onClick={() => setShowFiles((v) => !v)}
        title={showFiles ? '收起工作区文件' : '展开工作区文件'}
      >
        <span className={styles.collapseChevron}>{showFiles ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}</span>
        <span>工作区文件</span>
      </button>
      {showFiles ? (
        <div className={styles.mcpSection}>
          <FileTree
            onOpenFile={(path, content) => {
              setOutlinePath(path);
              onOpenFile?.(path, content);
            }}
          />
          <FileOutline
            path={outlinePath}
            onPickSymbol={(sym) => {
              onInsertText?.(`@symbol:${sym.name}`);
            }}
          />
        </div>
      ) : null}

      <div className={styles.divider} />

      {/*
        MCP and the knowledge tree are collapsible.
        They have fixed minimum heights, so with a long session list they used to
        squeeze the sidebar until nothing was fully visible.
      */}
      <button
        type="button"
        className={styles.collapseHeader}
        onClick={() => setShowMcp((v) => !v)}
        title={showMcp ? '收起 MCP 服务' : '展开 MCP 服务'}
      >
        <span className={styles.collapseChevron}>{showMcp ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}</span>
        <span>MCP 服务</span>
      </button>
      {showMcp ? (
        <div className={styles.mcpSection}>
          <McpPanel />
        </div>
      ) : null}

      <div className={styles.divider} />

      <div className={styles.collapseHeaderRow}>
        <button
          type="button"
          className={styles.collapseHeader}
          onClick={() => setShowKb((v) => !v)}
          title={showKb ? t('收起知识库') : t('展开知识库')}
        >
          <span className={styles.collapseChevron}>{showKb ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}</span>
          <span>{t('知识库')}</span>
        </button>
        {/*
          Entry point for the shared / merged knowledge base.
          That feature existed only inside Settings, about 950px down a 2900px scrolling form, so a
          user looking for "merge two libraries" in the knowledge base area — the obvious place —
          found nothing. The controls stay in Settings (they need the path inputs); this is the
          signpost, and it opens Settings at that block.
        */}
        {onOpenKbSharing ? (
          <button
            type="button"
            className={styles.collapseAction}
            onClick={onOpenKbSharing}
            title={t('共享 / 合并知识库（多个工作区贯穿同一套知识）')}
            aria-label={t('共享 / 合并知识库')}
          >
            <IconMerge size={13} />
          </button>
        ) : null}
      </div>
      {showKb ? (
        <div className={styles.treeContainer}>
          {tree.length === 0 ? (
            <div className={styles.emptyState}>
              {t('还没有组。')}<br />{t('导入对话记录或知识文件后会填充。')}
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
      ) : null}
    </div>
  );
}
