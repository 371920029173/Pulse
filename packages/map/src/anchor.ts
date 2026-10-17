/*
 * 压缩协同：把"被折叠那一段涉及的文件"变成一段**带标签的引用块**。
 *
 * 压缩的既有做法已经保住了文件名（anchors），但只有路径的话，模型压缩后还是不知道
 * 那些文件是干什么的——它得重新一个个打开看，等于压缩白省了。这里给每个锚点补上
 * 地图里的一句话标签，让"压缩后仍知道在改哪几个文件、各自是干什么的"成立。
 *
 * 三条纪律：
 *  - 只输出**引用**，不输出文件内容（压缩的意义就是丢掉内容）；
 *  - 预算硬上限（默认 400 token）：锚点多的时候先保引用数高的；
 *  - 没有标签的文件不编造，写「未标注」——地图不知道就说不知道。
 */
import { readIndex, readShardSafe } from './store.js';
import type { MapNode } from '@she/shared';

export interface AnchorBlock {
  text: string;
  /** 实际写进块的路径（受预算截断后）。 */
  included: string[];
  tokens: number;
}

export function mapAnchorBlock(root: string, paths: string[], budgetTokens = 400): AnchorBlock {
  const index = readIndex(root);
  if (!index || paths.length === 0) return { text: '', included: [], tokens: 0 };

  const byPath = new Map<string, MapNode>();
  for (const s of index.shards) {
    const { shard } = readShardSafe(root, s.key);
    if (!shard) continue;
    for (const n of shard.nodes) if (n.kind === 'file' && n.branch === index.branch) byPath.set(n.path, n);
  }

  /* 引用数高的先写：预算不够时，被依赖多的文件更值得占那点 token。 */
  const ordered = [...new Set(paths.map((p) => p.replace(/\\/g, '/')))].sort((a, b) => {
    const ia = byPath.get(a)?.inDegree ?? 0;
    const ib = byPath.get(b)?.inDegree ?? 0;
    return ib - ia || a.localeCompare(b);
  });

  const lines: string[] = ['涉及文件（地图引用，压缩后从这里接着看）:'];
  const included: string[] = [];
  for (const p of ordered) {
    const node = byPath.get(p);
    const label = node?.label ?? (node ? '未标注' : '不在图上');
    const next = `  ${p}  ${label}`;
    const candidate = [...lines, next].join('\n');
    if (Math.ceil(candidate.length / 3) > budgetTokens) break;
    lines.push(next);
    included.push(p);
  }
  if (included.length < ordered.length) lines.push(`  …另有 ${ordered.length - included.length} 个文件未列出（预算）`);

  const text = lines.join('\n');
  return { text, included, tokens: Math.ceil(text.length / 3) };
}
