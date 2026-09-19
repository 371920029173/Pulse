import { useCallback } from 'react';
import styles from '../styles/GroupBrowser.module.css';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { t } from '../lib/i18n';

interface GroupData {
  id: string;
  name: string;
  isDormant: boolean;
  isCompetitionSubgroup: boolean;
  hormoneMarker: number;
  trustConstant: number;
  stats: {
    totalMemories: number;
    directMemories: number;
    compressedMemories: number;
    totalChildren: number;
    accessCount: number;
  };
  childGroupIds: string[];
  memoryIds: string[];
  weakEdgeIds: string[];
  crossGroupEdgeIds: string[];
  competitionSubgroupIds: string[];
}

interface MemoryData {
  id: string;
  kind: string;
  title: string;
  content: string;
  accessCount: number;
  isDormant: boolean;
}

interface GroupBrowserProps {
  group: GroupData;
  memories: MemoryData[];
  onClose: () => void;
}

function KindBadge({ kind }: { kind: string }) {
  const colors: Record<string, string> = {
    code: 'var(--accent)',
    fact: 'var(--success)',
    text: 'var(--text-secondary)',
    tool_outcome: 'var(--warning)',
    preference: '#c084fc',
  };

  return (
    <span
      className={styles.kindBadge}
      style={{ borderColor: colors[kind] ?? 'var(--border)', color: colors[kind] ?? 'var(--text-secondary)' }}
    >
      {kind}
    </span>
  );
}

function StatItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div className={styles.statItem}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}

export function GroupBrowser({ group, memories, onClose }: GroupBrowserProps) {
  // Escape closes this dialog: the backdrop click is a mouse convenience, not a keyboard path.
  useEscapeToClose(onClose);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  }, [onClose]);

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.modal} data-surface="modal">
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.headerIcon}>⬡</span>
            <span className={styles.headerName}>{group.name}</span>
            {group.isDormant && <span className={styles.dormantTag}>dormant</span>}
            {group.isCompetitionSubgroup && <span className={styles.competitionTag}>competition</span>}
          </div>
          <button className={styles.closeBtn} onClick={onClose} title={t('关闭')} aria-label={t('关闭')}>×</button>
        </div>

        <div className={styles.stats}>
          <StatItem label="Memories" value={group.stats.totalMemories} />
          <StatItem label="Direct" value={group.stats.directMemories} />
          <StatItem label="Compressed" value={group.stats.compressedMemories} />
          <StatItem label="Children" value={group.stats.totalChildren} />
          <StatItem label="Accesses" value={group.stats.accessCount} />
          <StatItem label="Hormone" value={group.hormoneMarker.toFixed(2)} />
          <StatItem label="Trust" value={group.trustConstant.toFixed(2)} />
        </div>

        {group.competitionSubgroupIds.length > 0 && (
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Competition Subgroups</div>
            <div className={styles.tagList}>
              {group.competitionSubgroupIds.map((id) => (
                <span key={id} className={styles.competitionTag}>{id.slice(0, 8)}</span>
              ))}
            </div>
          </div>
        )}

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Memories ({memories.length})</div>
          <div className={styles.memoryList}>
            {memories.length === 0 ? (
              <div className={styles.emptyState}>No memories in this group</div>
            ) : (
              memories.map((mem) => (
                <div key={mem.id} className={`${styles.memoryItem} ${mem.isDormant ? styles.memoryDormant : ''}`}>
                  <div className={styles.memoryHeader}>
                    <KindBadge kind={mem.kind} />
                    <span className={styles.memoryTitle}>{mem.title}</span>
                    <span className={styles.memoryAccess}>{mem.accessCount}×</span>
                  </div>
                  <div className={styles.memoryContent}>
                    {mem.content.slice(0, 200)}
                    {mem.content.length > 200 ? '…' : ''}
                  </div>
                  <div className={styles.memoryId}>{mem.id}</div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Edges</div>
          <div className={styles.edgeList}>
            {group.weakEdgeIds.length > 0 && (
              <div className={styles.edgeGroup}>
                <span className={styles.edgeKind}>weak</span>
                <span className={styles.edgeCount}>{group.weakEdgeIds.length}</span>
              </div>
            )}
            {group.crossGroupEdgeIds.length > 0 && (
              <div className={styles.edgeGroup}>
                <span className={styles.edgeKind}>cross-group</span>
                <span className={styles.edgeCount}>{group.crossGroupEdgeIds.length}</span>
              </div>
            )}
            {group.weakEdgeIds.length === 0 && group.crossGroupEdgeIds.length === 0 && (
              <div className={styles.emptyState}>No edges</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
