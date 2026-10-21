/*
 * 地图可信度：map_verify。
 *
 * 规模越大，"地图错了"的代价越高，而地图腐烂是**无声**的：标签过期、注记指向已删的文件、
 * 边指向不存在的节点、大片区域从没被任何人标注。这些都不会抛异常，只会在某天让模型
 * 对着三个月前的描述改代码。
 *
 * 所以这里不只报一个分数，而是**分项列出**：过期率、黑暗角落、悬空边、孤立注记、坏分片、
 * 契约威胁数。分数只是给模型一个"要不要相信这张图"的把手，分项才是用来修的。
 *
 * 分数刻意不设门槛（不因为"标签覆盖率低"就判红）：新仓第一天必然全是未标注，
 * 一个第一天就红的检查会在第二天被人关掉。
 */
import { readIndex, readShardSafe, labelIsStale } from './store.js';
import type { MapNode, MapEdge, MapNote } from '@she/shared';

export interface VerifyReport {
  score: number;
  files: number;
  labels: number;
  staleLabels: number;
  staleRate: number;
  darkFiles: number;
  darkRate: number;
  danglingEdges: number;
  orphanNotes: number;
  brokenShards: number;
  contractCertain: number;
  contractThreats: number;
  /** 最该补的几条：按引用数排序的过期/未标注文件。 */
  worst: Array<{ path: string; why: string; inDegree: number }>;
  text: string;
}

export function mapVerify(root: string): VerifyReport {
  const index = readIndex(root);
  if (!index) {
    return {
      score: 0, files: 0, labels: 0, staleLabels: 0, staleRate: 0, darkFiles: 0, darkRate: 0,
      danglingEdges: 0, orphanNotes: 0, brokenShards: 0, contractCertain: 0, contractThreats: 0, worst: [],
      text: '(还没有地图：先跑 pnpm map:build)',
    };
  }

  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const notes: MapNote[] = [];
  let brokenShards = 0;
  for (const s of index.shards) {
    const { shard, broken } = readShardSafe(root, s.key);
    if (broken) {
      brokenShards += 1;
      continue;
    }
    if (!shard) continue;
    nodes.push(...shard.nodes);
    edges.push(...shard.edges);
    notes.push(...shard.notes);
  }

  const files = nodes.filter((n) => n.kind === 'file');
  const paths = new Set(files.map((f) => f.path));
  const labeled = files.filter((f) => f.label);
  const stale = labeled.filter((f) => labelIsStale(f));

  /* 黑暗角落：没有标签、也没被读过（lastSeen 只有建图时间，等于从没被 agent 看过）。 */
  const dark = files.filter((f) => !f.label);

  /*
   * 悬空边：两端必须都指向存在的节点。用 Set 而不是 some 扫描——
   * 2500 条边 × 800 个节点 = 200 万次比较，没必要，而且写起来更容易错。
   */
  const nodePaths = new Set(nodes.map((n) => n.path));
  const danglingCount = edges.filter((e) => !nodePaths.has(e.from) || !nodePaths.has(e.to)).length;

  const orphanNotes = notes.filter((n) => !paths.has(n.path)).length;
  const contractEdges = edges.filter((e) => e.kind === 'contract');
  const contractCertain = contractEdges.filter((e) => e.confidence === 'certain').length;
  const contractThreats = contractEdges.filter((e) => e.confidence !== 'certain').length;

  const filesCount = files.length || 1;
  const staleRate = labeled.length ? stale.length / labeled.length : 0;
  const darkRate = dark.length / filesCount;

  /* 扣分权重：过期标签最贵（会说错话），其次是悬空边（会让影响面算错）。 */
  let score = 100;
  score -= Math.round(staleRate * 30);
  score -= Math.round(darkRate * 25);
  score -= Math.min(20, danglingCount);
  score -= Math.min(10, orphanNotes * 2);
  score -= brokenShards * 10;
  score = Math.max(0, Math.min(100, score));
  /*
   * 一条标签都没有时，分数必须封顶：这张图对"意图检索"是不可用的，
   * 而 75/100 会让模型以为可以信。分项数字（0 标签 / 100% 黑暗角落）才是事实。
   */
  const retrievalUsable = labeled.length > 0;
  if (!retrievalUsable) score = Math.min(score, 30);

  const worst = [
    ...stale.map((f) => ({ path: f.path, why: '标签已过期', inDegree: f.inDegree ?? 0 })),
    ...dark.map((f) => ({ path: f.path, why: '从未标注', inDegree: f.inDegree ?? 0 })),
  ]
    .sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path))
    .slice(0, 8);

  const lines = [
    `地图可信度 ${score}/100（${index.branch}）${retrievalUsable ? '' : ' —— 没有任何标签，意图检索（whereis/scope）当前不可用，只能按路径匹配'}`,
    `  文件 ${files.length}｜已标注 ${labeled.length}（过期 ${stale.length}，${Math.round(staleRate * 100)}%）`,
    `  黑暗角落 ${dark.length}（${Math.round(darkRate * 100)}%：没有任何标签的区域）`,
    `  悬空边 ${danglingCount}｜孤立注记 ${orphanNotes}｜坏分片 ${brokenShards}`,
    `  契约 确定 ${contractCertain}｜潜在威胁 ${contractThreats}`,
    `  接线 ${index.wiringEdges ?? 0} 条（带符号名）｜未解析 ${index.wiringUnresolved ?? 0} 条引用`,
  ];
  if (worst.length) {
    lines.push('  最该补（按引用数）：');
    for (const w of worst) lines.push(`    ${w.path}  ${w.why}  (引用 ${w.inDegree})`);
  }

  return {
    score, files: files.length, labels: labeled.length, staleLabels: stale.length, staleRate,
    darkFiles: dark.length, darkRate, danglingEdges: danglingCount, orphanNotes, brokenShards,
    contractCertain, contractThreats, worst, text: lines.join('\n'),
  };
}
