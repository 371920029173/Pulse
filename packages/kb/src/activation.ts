/**
 * 记忆的激活账：谁在被用，谁已经凉了。
 *
 * `accessCount` / `lastAccessedAt` 一直在维护（检索落到某个节点就会加一），但从来没有一次把它们
 * **成批读回来**：于是「哪些知识真的在被用」没有答案 —— 清理只能凭感觉，也看不见一个节点在变凉之前
 * 的样子（`isDormant` 只在真的休眠**之后**才说话，那已经晚了）。
 *
 * 纯函数，只读；调用方给窗口大小。排序是确定的（同分按 id 稳定），这样两次调用之间只有真实变化
 * 才会让列表动。
 */
import type { KBStore } from './store.js';

export interface ActivationRow {
  id: string;
  title: string;
  groupIds: string[];
  accessCount: number;
  /** 0 表示从未被访问过。 */
  lastAccessedAt: number;
  /** 距今多久没被访问过（从未访问按创建时间算），取整到天。 */
  idleDays: number;
  isDormant: boolean;
}

export interface ActivationReport {
  total: number;
  /** 从未被访问过的节点数 —— 「只写不读」的那一类。 */
  neverAccessed: number;
  /** 访问最多、且最近还在被用的（默认前 10）。 */
  hot: ActivationRow[];
  /** 最久没被访问的（默认前 10）。 */
  cold: ActivationRow[];
}

export function activationReport(
  store: KBStore,
  opts: { hot?: number; cold?: number; now?: number } = {},
): ActivationReport {
  const now = opts.now ?? Date.now();
  const rows: ActivationRow[] = [];
  for (const g of store.getAllGroups()) {
    for (const m of store.getMemoriesByGroup(g.id)) {
      const stamp = m.lastAccessedAt || m.createdAt || now;
      rows.push({
        id: m.id,
        title: m.title,
        groupIds: m.groupIds ?? [g.id],
        accessCount: m.accessCount ?? 0,
        lastAccessedAt: m.lastAccessedAt ?? 0,
        idleDays: Math.max(0, Math.round((now - stamp) / 86_400_000)),
        isDormant: Boolean(m.isDormant),
      });
    }
  }

  const hot = rows
    .filter((r) => r.accessCount > 0)
    .sort((a, b) => b.accessCount - a.accessCount || a.idleDays - b.idleDays || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, opts.hot ?? 10));

  const cold = [...rows]
    .sort((a, b) => b.idleDays - a.idleDays || a.accessCount - b.accessCount || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, opts.cold ?? 10));

  return {
    total: rows.length,
    neverAccessed: rows.filter((r) => r.accessCount === 0).length,
    hot,
    cold,
  };
}
