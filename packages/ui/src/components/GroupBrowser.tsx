import { useCallback, useEffect, useState } from 'react';
import { fetchJSON } from '../lib/api';
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

/** `/api/kb/activation` 的形状（只取这个面板要显示的几格）。 */
interface Activation {
  total: number;
  neverAccessed: number;
  hot: { id: string; title: string; accessCount: number }[];
  cold: { id: string; title: string; idleDays: number }[];
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
  /*
   * 全库激活账。放在这里是因为它是本仓库**唯一**的知识库面板：每个节点上都有 `accessCount`，
   * 但"整库谁在被用、谁凉了"从来没有一个地方看得见。读不到就显示"读不到"，不假装是空库。
   */
  const [activation, setActivation] = useState<Activation | null>(null);
  useEffect(() => {
    let alive = true;
    void fetchJSON<Activation>('/api/kb/activation').then(
      (a) => { if (alive) setActivation(a); },
      () => { if (alive) setActivation(null); },
    );
    return () => { alive = false; };
  }, []);

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
          <div className={styles.sectionTitle}>{t('激活（全库）')}</div>
          {activation === null ? (
            <div className={styles.emptyState}>{t('读不到激活账')}</div>
          ) : (
            <div className={styles.stats}>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>{t('节点')}</span>
                <span className={styles.statValue}>{String(activation.total)}</span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>{t('从未被访问')}</span>
                <span className={styles.statValue}>{String(activation.neverAccessed)}</span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>{t('最活跃')}</span>
                <span className={styles.statValue}>{activation.hot[0] ? `${activation.hot[0].title}（${activation.hot[0].accessCount}×）` : '—'}</span>
              </div>
              <div className={styles.statItem}>
                <span className={styles.statLabel}>{t('最冷')}</span>
                <span className={styles.statValue}>{activation.cold[0] ? t('{title}（{idleDays} 天）', { title: (activation.cold[0].title), idleDays: (activation.cold[0].idleDays) }) : '—'}</span>
              </div>
            </div>
          )}
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
