/*
 * L0 常驻记忆卡：每轮告诉模型「库里有哪些领域、各多少条、最近一次写入」。
 *
 * 为什么需要它（2026-10-27，用户的原话）：模型「不知道自己不知道什么」，所以不回查 KB。
 * 工具描述只能说明"有这个能力"，无法说明"这条记忆此刻相关"；而一张目录卡至少让它知道
 * **哪些领域有据可查**，于是判断得出"这题可能该查"。
 *
 * 三条硬约束：
 *   1. ≤400 token —— 它每轮都要发，属于固定成本（按 3.47 字符/token 算，约 1400 字符）；
 *   2. 稳定 —— 内容只由库的形状决定，随会话冻结在 system-message.json 里，前缀缓存不受影响；
 *   3. 只读 —— 失败就返回空串，绝不能让一张目录卡挡住对话。
 */
import type { GroupKBEngine } from '@she/kb';

const CHAR_BUDGET = 1_400;

interface Groupish {
  id: string;
  name: string;
  stats?: { totalMemories?: number; directMemories?: number };
}

interface Storeish {
  getAllGroups(): Groupish[];
  getMemoriesByGroup(id: string): { updatedAt?: number; createdAt?: number }[];
}

/** 一层深度：顶层组按名字聚合（`project/alpha/lessons` 归到 `project`），带条数与最近写入。 */
export function composeKbIndexCard(engine: GroupKBEngine | null | undefined): string {
  if (!engine) return '';
  try {
    const store = (engine as unknown as { store?: Storeish }).store;
    if (!store) return '';
    const groups = store.getAllGroups();
    if (!groups.length) return '';

    const tops = new Map<string, { total: number; last: number; subs: number }>();
    for (const g of groups) {
      const top = String(g.name ?? '').split('/').filter(Boolean)[0];
      if (!top) continue;
      const direct = store.getMemoriesByGroup(g.id) ?? [];
      const count = g.stats?.totalMemories ?? direct.length;
      const last = direct.reduce((m, x) => Math.max(m, x.updatedAt ?? x.createdAt ?? 0), 0);
      const cur = tops.get(top) ?? { total: 0, last: 0, subs: 0 };
      cur.total += count;
      cur.last = Math.max(cur.last, last);
      cur.subs += 1;
      tops.set(top, cur);
    }
    if (!tops.size) return '';

    const when = (t: number) => (t ? new Date(t).toISOString().slice(0, 10) : '—');
    const rows = [...tops.entries()].sort((a, b) => b[1].total - a[1].total);
    const lines: string[] = ['## 记忆库目录（每轮常驻；知道这里有哪几类，判断得出"该不该查"）'];
    let used = lines[0].length;
    for (const [name, v] of rows) {
      const line = `- ${name}：${v.total} 条，${v.subs} 个组，最近写入 ${when(v.last)}`;
      if (used + line.length > CHAR_BUDGET) {
        lines.push(`- …另外 ${rows.length - lines.length + 1} 个顶层组（用 kb_groups 看全）`);
        break;
      }
      lines.push(line);
      used += line.length + 1;
    }
    lines.push('（这些组里有历史决定/踩坑/约定；回答涉及它们时先用 kb_query 查，不要凭印象。）');
    return lines.join('\n');
  } catch {
    return '';
  }
}
