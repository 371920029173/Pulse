import React, { useState, useCallback } from 'react';
import type { KBQueryResult, ActivationTrace, PulseHop } from '../hooks/useKB';
import styles from '../styles/PulseTracePanel.module.css';

interface PulseTracePanelProps {
  result: KBQueryResult | null;
  onClose: () => void;
}

const EDGE_LABELS: Record<string, string> = {
  weak: '弱边',
  co_occurrence: '共现',
  temporal: '时序',
  causal_candidate: '因果候选',
  hierarchical: '层级',
  cross_group: '跨组',
  group_member: '同组',
  parent_child: '父→子',
};
function energyColor(energy: number): string {
  const h = 210;
  const s = 80;
  const l = Math.round(30 + energy * 50);
  const a = Math.max(0.25, energy);
  return `hsla(${h}, ${s}%, ${l}%, ${a})`;
}

function activationColor(level: number): string {
  if (level >= 0.7) return 'var(--success)';
  if (level >= 0.4) return 'var(--accent)';
  if (level >= 0.2) return 'var(--warning)';
  return 'var(--text-tertiary)';
}

function HopArrow({ hop }: { hop: PulseHop }) {
  const badgeClass = styles[`hopBadge_${hop.edgeKind}` as keyof typeof styles] || styles.hopBadge_weak;
  const lineColor = energyColor(hop.energyAfter);

  return (
    <div className={styles.hopArrow}>
      <div className={styles.hopLine}>
        <div className={styles.hopLineSegment} style={{ background: lineColor }} />
        <div className={styles.hopLineArrow} style={{ color: lineColor }}>▼</div>
      </div>
      <div className={styles.hopDetail}>
        <span className={`${styles.hopBadge} ${badgeClass}`}>
          {EDGE_LABELS[hop.edgeKind] ?? hop.edgeKind}
        </span>
        <span className={styles.hopEnergy}>
          {hop.energyBefore.toFixed(2)} → {hop.energyAfter.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

function TraceEntry({ trace }: { trace: ActivationTrace }) {
  const [expanded, setExpanded] = useState(false);

  const toggleExpand = useCallback(() => setExpanded((v) => !v), []);

  const allHops: PulseHop[] = [];
  for (const seed of trace.pulseSeeds) {
    for (const hop of seed.path) {
      allHops.push(hop);
    }
  }

  const totalEnergy = trace.pulseSeeds.reduce((sum, s) => sum + s.energy, 0);
  const maxEnergy = Math.max(1, totalEnergy);

  return (
    <div className={styles.traceEntry}>
      {/*
        A <button> rather than a div with onClick: this expands the trace entry, so it
        is a control and has to be reachable and operable from the keyboard. Marked up
        as a disclosure so the state is announced instead of only being visible.
      */}
      <button
        type="button"
        className={styles.seedNode}
        onClick={toggleExpand}
        aria-expanded={expanded}
      >
        <div
          className={styles.seedIcon}
          style={{ background: energyColor(trace.activationLevel) }}
        >
          ◉
        </div>
        <div className={styles.seedInfo}>
          <div className={styles.seedId}>
            {trace.nodeId.slice(0, 12)}…
          </div>
          <div className={styles.seedReason}>{trace.reason}</div>
        </div>
        <div className={styles.seedActivation}>
          <span
            className={styles.seedActivationValue}
            style={{ color: activationColor(trace.activationLevel) }}
          >
            {trace.activationLevel.toFixed(3)}
          </span>
          <div className={styles.energyBar}>
            <div
              className={styles.energyFill}
              style={{
                width: `${Math.min(100, trace.activationLevel * 100)}%`,
                background: activationColor(trace.activationLevel),
              }}
            />
          </div>
        </div>
      </button>

      {allHops.map((hop, i) => (
        <HopArrow key={`${hop.fromId}-${hop.toId}-${i}`} hop={hop} />
      ))}

      {trace.pulseSeeds.length > 0 && (
        <div className={styles.hopArrow}>
          <div className={styles.hopLine}>
            <div
              className={styles.hopLineSegment}
              style={{ background: energyColor(totalEnergy / maxEnergy) }}
            />
          </div>
          <div className={styles.hopDetail}>
            <span className={styles.hopEnergy}>
              {trace.pulseSeeds.length} 个种子 · 总能量 {totalEnergy.toFixed(3)}
            </span>
          </div>
        </div>
      )}

      {expanded && (
        <div className={styles.traceDetail}>
          <div className={styles.traceDetailRow}>
            <span className={styles.traceDetailLabel}>节点 ID</span>
            <span className={styles.traceDetailValue}>{trace.nodeId}</span>
          </div>
          <div className={styles.traceDetailRow}>
            <span className={styles.traceDetailLabel}>激活能量</span>
            <span className={styles.traceDetailValue}>{trace.activationLevel.toFixed(4)}</span>
          </div>
          <div className={styles.traceDetailRow}>
            <span className={styles.traceDetailLabel}>种子数</span>
            <span className={styles.traceDetailValue}>{trace.pulseSeeds.length}</span>
          </div>
          <div className={styles.traceDetailRow}>
            <span className={styles.traceDetailLabel}>跳数</span>
            <span className={styles.traceDetailValue}>{allHops.length}</span>
          </div>
          {trace.groupPath.length > 0 && (
            <div className={styles.groupPath}>
              {trace.groupPath.map((seg, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span className={styles.groupPathArrow}>›</span>}
                  <span className={styles.groupPathSegment}>{seg}</span>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PulseTracePanel({ result, onClose }: PulseTracePanelProps) {
  return (
    <div className={styles.panel} data-surface="panel">
      <div className={styles.header}>
        <div className={styles.headerTitle}>
          <span className={styles.headerDot} />
          组结构共振轨迹
        </div>
        <button className={styles.closeBtn} onClick={onClose} title="关闭面板（Esc）">
          ×
        </button>
      </div>

      {!result ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>◉</div>
          <div>还没有共振轨迹</div>
          <div style={{ fontSize: '11px', opacity: 0.7 }}>
            智能体查询知识库时，这里会显示激活路径
          </div>
        </div>
      ) : (
        <>
          <div className={styles.metaBar}>
            <div className={styles.metaItem}>
              命中: <span className={styles.metaValue}>{result.nodes.length}</span>
            </div>
            <div className={styles.metaItem}>
              扫描: <span className={styles.metaValue}>{result.totalNodesScanned}</span>
            </div>
            <div className={styles.metaItem}>
              耗时: <span className={styles.metaValue}>{result.queryTimeMs}ms</span>
            </div>
          </div>

          <div className={styles.body}>
            {result.traces.length === 0 ? (
              <div className={styles.empty}>
                <div>本次查询没有共振轨迹</div>
              </div>
            ) : (
              result.traces.map((trace, i) => (
                <TraceEntry key={`${trace.nodeId}-${i}`} trace={trace} />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
