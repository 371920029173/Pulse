import { basename } from 'node:path';
import { KBStore } from './store.js';

export interface MergeKbResult {
  groups: number;
  memories: number;
  edges: number;
  targetPath: string;
  rootGroupId: string;
}

/**
 * Copy every group / memory / edge from `sourcePath` into `targetPath`.
 *
 * IDs are remapped so two PulseSeed graphs can be joined without collisions.
 * Everything lands under a new root group named after the source file, so the
 * merge stays inspectable and reversible (delete that group tree later).
 */
export function mergeKnowledgeBases(
  sourcePath: string,
  targetPath: string,
  opts?: { label?: string },
): MergeKbResult {
  if (sourcePath === targetPath) {
    throw new Error('源库与目标库是同一个文件，无需合并');
  }

  const src = new KBStore(sourcePath);
  const dst = new KBStore(targetPath);
  try {
    const label = (opts?.label || basename(sourcePath).replace(/\.sqlite$/i, '') || 'merged').slice(0, 80);
    const root = dst.createGroup({ name: `合并自 · ${label}` });
    const groupMap = new Map<string, string>();
    const memoryMap = new Map<string, string>();

    // Parents before children: sort by parent-chain depth (approx via repeated passes).
    const allGroups = src.getAllGroups();
    const pending = [...allGroups];
    let guard = 0;
    while (pending.length && guard < allGroups.length + 5) {
      guard += 1;
      const next: typeof pending = [];
      for (const g of pending) {
        if (g.parentGroupId && !groupMap.has(g.parentGroupId) && allGroups.some((x) => x.id === g.parentGroupId)) {
          next.push(g);
          continue;
        }
        const parentId = g.parentGroupId ? groupMap.get(g.parentGroupId) ?? root.id : root.id;
        const created = dst.createGroup({ name: g.name, parentGroupId: parentId });
        groupMap.set(g.id, created.id);
        dst.updateGroup(created.id, {
          nameIsGroupRef: g.nameIsGroupRef,
          hormoneMarker: g.hormoneMarker,
          trustConstant: g.trustConstant,
          isDormant: g.isDormant,
          maxChildrenBeforeSplit: g.maxChildrenBeforeSplit,
          stats: g.stats,
          localIndex: g.localIndex,
        });
      }
      if (next.length === pending.length) {
        // cycle / orphan ? attach remaining under root
        for (const g of next) {
          const created = dst.createGroup({ name: g.name, parentGroupId: root.id });
          groupMap.set(g.id, created.id);
        }
        break;
      }
      pending.length = 0;
      pending.push(...next);
    }

    for (const g of allGroups) {
      const memories = src.getMemoriesByGroup(g.id);
      for (const m of memories) {
        if (memoryMap.has(m.id)) continue;
        const mappedGroups = (m.groupIds || [])
          .map((id) => groupMap.get(id))
          .filter((id): id is string => Boolean(id));
        if (!mappedGroups.length) mappedGroups.push(groupMap.get(g.id) || root.id);
        const created = dst.createMemory({
          kind: m.kind,
          title: m.title,
          content: m.content,
          metadata: { ...(m.metadata || {}), mergedFrom: sourcePath, originalId: m.id },
          groupIds: mappedGroups,
        });
        memoryMap.set(m.id, created.id);
        if (m.isDormant) dst.updateMemory(created.id, { isDormant: true });
      }
    }

    // Edges: only those whose endpoints we remapped
    let edges = 0;
    for (const g of allGroups) {
      const mems = src.getMemoriesByGroup(g.id);
      for (const m of mems) {
        for (const e of src.getEdgesForNode(m.id)) {
          const s = memoryMap.get(e.sourceId) || groupMap.get(e.sourceId);
          const t = memoryMap.get(e.targetId) || groupMap.get(e.targetId);
          if (!s || !t) continue;
          try {
            dst.createEdge({
              kind: e.kind,
              sourceId: s,
              targetId: t,
              weight: e.weight,
              direction: e.direction,
              evidence: e.evidence,
              falsifiers: e.falsifiers,
            });
            edges += 1;
          } catch {
            /* duplicate / invalid ? skip */
          }
        }
      }
    }

    return {
      groups: groupMap.size,
      memories: memoryMap.size,
      edges,
      targetPath,
      rootGroupId: root.id,
    };
  } finally {
    try { src.close(); } catch { /* ignore */ }
    try { dst.close(); } catch { /* ignore */ }
  }
}
