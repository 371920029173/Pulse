import React, { useState, useCallback } from 'react';
import type { KBQueryResult, ActivationTrace, PulseHop } from '../hooks/useKB';
import styles from '../styles/PulseTracePanel.module.css';

interface PulseTracePanelProps {
  result: KBQueryResult | null;
  onClose: () => void;
}

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
          {hop.edgeKind}
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
      <div className={styles.seedNode} onClick={toggleExpand}>
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
      </div>

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
              {trace.pulseSeeds.length} seed{trace.pulseSeeds.length !== 1 ? 's' : ''} · Σ energy {totalEnergy.toFixed(3)}
            </span>
          </div>
        </div>
      )}

      {expanded && (
        <div className={styles.traceDetail}>
          <div className={styles.traceDetailRow}>
            <span className={styles.traceDetailLabel}>Node ID</span>
            <span className={styles.traceDetailValue}>{trace.nodeId}</span>
          </div>
          <div className={styles.traceDetailRow}>
            <span className={styles.traceDetailLabel}>Activation</span>
            <span className={styles.traceDetailValue}>{trace.activationLevel.toFixed(4)}</span>
          </div>
          <div className={styles.traceDetailRow}>
            <span className={styles.traceDetailLabel}>Seeds</span>
            <span className={styles.traceDetailValue}>{trace.pulseSeeds.length}</span>
          </div>
          <div className={styles.traceDetailRow}>
            <span className={styles.traceDetailLabel}>Total hops</span>
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
    <div className={styles.panel}>
      <div className={styles.header}>
        <div className={styles.headerTitle}>
          <span className={styles.headerDot} />
          PulseSeed Trace
        </div>
        <button className={styles.closeBtn} onClick={onClose} title="Close panel (Esc)">
          ×
        </button>
      </div>

      {!result ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>◉</div>
          <div>No activation traces yet</div>
          <div style={{ fontSize: '11px', opacity: 0.7 }}>
            Traces appear when the agent queries the KB
          </div>
        </div>
      ) : (
        <>
          <div className={styles.metaBar}>
            <div className={styles.metaItem}>
              Nodes: <span className={styles.metaValue}>{result.nodes.length}</span>
            </div>
            <div className={styles.metaItem}>
              Scanned: <span className={styles.metaValue}>{result.totalNodesScanned}</span>
            </div>
            <div className={styles.metaItem}>
              Time: <span className={styles.metaValue}>{result.queryTimeMs}ms</span>
            </div>
          </div>

          <div className={styles.body}>
            {result.traces.length === 0 ? (
              <div className={styles.empty}>
                <div>No activation traces in this result</div>
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
