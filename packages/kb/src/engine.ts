import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type {
  Group,
  MemoryNode,
  Edge,
  EdgeKind,
  KBQueryResult,
  ActivationTrace,
  PulseSeed,
  PulseHop,
  SheConfig,
} from '@she/shared';
import { KBStore } from './store.js';
import type { CreateEdgeInput } from './store.js';

/**
 * Metadata key marking a memory as retired (see `retireMemory`).
 *
 * A flag in `metadata` rather than a delete or a new column, the same shape the error book uses for
 * a forgotten entry: a retired conclusion is still evidence of what was once believed, and an
 * existing kb.sqlite needs no migration — a node without the key is simply active.
 */
export const KB_RETIRED_KEY = 'kbRetired';
/** Metadata key holding earlier versions of an edited memory (see `reviseMemory`). */
export const KB_HISTORY_KEY = 'kbHistory';
/** Metadata key holding the version number of an edited memory. Absent means version 1. */
export const KB_VERSION_KEY = 'kbVersion';
/** How many earlier versions an edited memory keeps. The newest are kept. */
export const KB_HISTORY_MAX = 10;

export interface KBRetirement {
  /** Epoch ms. */
  at: number;
  reason: string;
  /** The node that supersedes this one, when there is one. */
  replacedBy?: string;
}

export interface KBRevision {
  /** Epoch ms the version was REPLACED (not created). */
  at: number;
  version: number;
  kind: MemoryNode['kind'];
  title: string;
  content: string;
  reason?: string;
}

export interface KBMemoryPatch {
  title?: string;
  content?: string;
  kind?: MemoryNode['kind'];
}

export interface KBReviseResult {
  before: MemoryNode;
  after: MemoryNode;
  /** Which fields actually changed; empty means nothing was written. */
  changed: Array<'title' | 'content' | 'kind'>;
  /** Version number of `after`. */
  version: number;
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh',
  '.sql', '.graphql', '.proto', '.vue', '.svelte',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}


export class GroupKBEngine {
  private store: KBStore;
  private config: SheConfig['kb'];

  constructor(store: KBStore, config: SheConfig['kb']) {
    this.store = store;
    this.config = config;
  }

  // ─── Group management ───

  createGroup(name: string, parentId?: string): Group {
    return this.store.transaction(() => {
      const group = this.store.createGroup({
        name,
        parentGroupId: parentId ?? null,
        maxChildrenBeforeSplit: this.config.maxChildrenBeforeSplit,
      });

      if (parentId) {
        const parent = this.store.getGroup(parentId);
        if (!parent) throw new Error(`Parent group not found: ${parentId}`);
        this.store.updateGroup(parentId, {
          childGroupIds: [...parent.childGroupIds, group.id],
          stats: { ...parent.stats, totalChildren: parent.stats.totalChildren + 1 },
        });
      }

      return group;
    });
  }

  deleteGroup(id: string): void {
    this.store.transaction(() => {
      const group = this.store.getGroup(id);
      if (!group) throw new Error(`Group not found: ${id}`);

      if (group.parentGroupId) {
        const parent = this.store.getGroup(group.parentGroupId);
        if (parent) {
          this.store.updateGroup(parent.id, {
            childGroupIds: parent.childGroupIds.filter(c => c !== id),
            stats: { ...parent.stats, totalChildren: parent.stats.totalChildren - 1 },
          });

          for (const childId of group.childGroupIds) {
            const child = this.store.getGroup(childId);
            if (child) {
              this.store.updateGroup(childId, { parentGroupId: parent.id });
              this.store.updateGroup(parent.id, {
                childGroupIds: [...(this.store.getGroup(parent.id)!.childGroupIds), childId],
              });
            }
          }
        }
      } else {
        for (const childId of group.childGroupIds) {
          this.store.updateGroup(childId, { parentGroupId: null });
        }
      }

      this.store.deleteGroup(id);
    });
  }

  addChildGroup(parentId: string, childId: string): void {
    this.store.transaction(() => {
      const parent = this.store.getGroup(parentId);
      if (!parent) throw new Error(`Parent group not found: ${parentId}`);
      const child = this.store.getGroup(childId);
      if (!child) throw new Error(`Child group not found: ${childId}`);

      if (this.wouldCreateCycle(parentId, childId)) {
        throw new Error(`Adding child ${childId} to parent ${parentId} would create a cycle`);
      }

      if (child.parentGroupId && child.parentGroupId !== parentId) {
        const oldParent = this.store.getGroup(child.parentGroupId);
        if (oldParent) {
          this.store.updateGroup(oldParent.id, {
            childGroupIds: oldParent.childGroupIds.filter(c => c !== childId),
            stats: { ...oldParent.stats, totalChildren: oldParent.stats.totalChildren - 1 },
          });
        }
      }

      if (!parent.childGroupIds.includes(childId)) {
        this.store.updateGroup(parentId, {
          childGroupIds: [...parent.childGroupIds, childId],
          stats: { ...parent.stats, totalChildren: parent.stats.totalChildren + 1 },
        });
      }
      this.store.updateGroup(childId, { parentGroupId: parentId });
    });
  }

  removeChildGroup(parentId: string, childId: string): void {
    this.store.transaction(() => {
      const parent = this.store.getGroup(parentId);
      if (!parent) throw new Error(`Parent group not found: ${parentId}`);

      this.store.updateGroup(parentId, {
        childGroupIds: parent.childGroupIds.filter(c => c !== childId),
        stats: { ...parent.stats, totalChildren: parent.stats.totalChildren - 1 },
      });

      const child = this.store.getGroup(childId);
      if (child && child.parentGroupId === parentId) {
        this.store.updateGroup(childId, { parentGroupId: null });
      }
    });
  }

  private wouldCreateCycle(parentId: string, childId: string): boolean {
    if (parentId === childId) return true;

    const visited = new Set<string>();
    const stack = [parentId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      // Reaching the candidate child via the parent chain *is* the cycle.
      if (current === childId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const group = this.store.getGroup(current);
      if (!group) continue;

      if (group.parentGroupId) {
        if (group.parentGroupId === childId) return true;
        stack.push(group.parentGroupId);
      }

      if (group.nameIsGroupRef) {
        const refTarget = this.store.getAllGroups().find(g => g.name === group.name && g.id !== current);
        if (refTarget) {
          if (refTarget.id === childId) return true;
          stack.push(refTarget.id);
        }
      }
    }

    return false;
  }

  shouldSplit(groupId: string): boolean {
    const group = this.store.getGroup(groupId);
    if (!group) return false;
    return group.memoryIds.length > group.maxChildrenBeforeSplit;
  }

  /**
   * Split an overfull group by distributing memories evenly (round-robin by
   * creation order). NO k-means, NO semantic clustering — purely structural.
   */
  splitGroup(groupId: string): Group[] {
    return this.store.transaction(() => {
      const group = this.store.getGroup(groupId);
      if (!group) throw new Error(`Group not found: ${groupId}`);

      const memories = group.memoryIds
        .map(id => this.store.getMemory(id))
        .filter((m): m is MemoryNode => m !== undefined);

      if (memories.length <= 3) return [group];

      const numBuckets = Math.min(3, Math.ceil(memories.length / 4));
      const buckets: MemoryNode[][] = Array.from({ length: numBuckets }, () => []);

      memories.sort((a, b) => a.createdAt - b.createdAt);
      for (let i = 0; i < memories.length; i++) {
        buckets[i % numBuckets].push(memories[i]);
      }

      const newGroups: Group[] = [];

      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        if (bucket.length === 0) continue;

        // Number parts by the parent's existing child count so repeated splits
        // produce unique names instead of part-1/part-2/part-3 repeating.
        const partIndex = group.childGroupIds.length + i + 1;
        const subName = `${group.name}/part-${partIndex}`;
        const sub = this.store.createGroup({
          name: subName,
          parentGroupId: groupId,
          maxChildrenBeforeSplit: group.maxChildrenBeforeSplit,
        });

        const memIds = bucket.map(m => m.id);
        this.store.updateGroup(sub.id, {
          memoryIds: memIds,
          stats: {
            ...sub.stats,
            totalMemories: memIds.length,
            directMemories: memIds.length,
          },
        });

        for (const mem of bucket) {
          const gids = mem.groupIds.filter(g => g !== groupId);
          gids.push(sub.id);
          this.store.updateMemory(mem.id, { groupIds: gids });
        }

        newGroups.push(this.store.getGroup(sub.id)!);
      }

      this.store.updateGroup(groupId, {
        childGroupIds: [...group.childGroupIds, ...newGroups.map(g => g.id)],
        memoryIds: [],
        stats: {
          ...group.stats,
          directMemories: 0,
          totalChildren: group.stats.totalChildren + newGroups.length,
        },
      });

      return newGroups;
    });
  }

  findGroupForMemory(memoryId: string): Group[] {
    const memory = this.store.getMemory(memoryId);
    if (!memory) return [];
    return memory.groupIds
      .map(gid => this.store.getGroup(gid))
      .filter((g): g is Group => g !== undefined);
  }

  // ─── Memory management ───

  addMemory(
    groupId: string,
    kind: MemoryNode['kind'],
    title: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): MemoryNode {
    return this.store.transaction(() => {
      const group = this.store.getGroup(groupId);
      if (!group) throw new Error(`Group not found: ${groupId}`);

      const memory = this.store.createMemory({
        kind,
        title,
        content,
        metadata,
        groupIds: [groupId],
      });

      this.store.updateGroup(groupId, {
        memoryIds: [...group.memoryIds, memory.id],
        stats: {
          ...group.stats,
          totalMemories: group.stats.totalMemories + 1,
          directMemories: group.stats.directMemories + 1,
        },
      });

      return memory;
    });
  }

  /**
   * Add a memory and keep its group healthy.
   *
   * If the group has grown past `maxChildrenBeforeSplit`, split it into
   * structural subgroups. This is the POLICY layer: `addMemory` stays a
   * predictable primitive, while ingestion and agent writes go through here so
   * that `maxChildrenBeforeSplit` is actually enforced instead of being dead
   * configuration. Unbounded groups make co-membership resonance meaningless —
   * every member inherits the same activation from any one member.
   */
  addMemoryMaintained(
    groupId: string,
    kind: MemoryNode['kind'],
    title: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): MemoryNode {
    const memory = this.addMemory(groupId, kind, title, content, metadata);
    try {
      if (this.shouldSplit(groupId)) this.splitGroup(groupId);
    } catch {
      // Never lose the memory we just wrote because housekeeping failed.
    }
    return memory;
  }

  removeMemory(groupId: string, memoryId: string): void {
    this.store.transaction(() => {
      const group = this.store.getGroup(groupId);
      if (!group) throw new Error(`Group not found: ${groupId}`);

      this.store.updateGroup(groupId, {
        memoryIds: group.memoryIds.filter(m => m !== memoryId),
        stats: {
          ...group.stats,
          totalMemories: Math.max(0, group.stats.totalMemories - 1),
          directMemories: Math.max(0, group.stats.directMemories - 1),
        },
      });

      const memory = this.store.getMemory(memoryId);
      if (memory) {
        const remaining = memory.groupIds.filter(g => g !== groupId);
        if (remaining.length === 0) {
          this.store.deleteMemory(memoryId);
        } else {
          this.store.updateMemory(memoryId, { groupIds: remaining });
        }
      }
    });
  }

  moveMemory(fromGroupId: string, toGroupId: string, memoryId: string): void {
    this.store.transaction(() => {
      const fromGroup = this.store.getGroup(fromGroupId);
      if (!fromGroup) throw new Error(`Source group not found: ${fromGroupId}`);
      const toGroup = this.store.getGroup(toGroupId);
      if (!toGroup) throw new Error(`Target group not found: ${toGroupId}`);
      const memory = this.store.getMemory(memoryId);
      if (!memory) throw new Error(`Memory not found: ${memoryId}`);

      this.store.updateGroup(fromGroupId, {
        memoryIds: fromGroup.memoryIds.filter(m => m !== memoryId),
        stats: {
          ...fromGroup.stats,
          totalMemories: Math.max(0, fromGroup.stats.totalMemories - 1),
          directMemories: Math.max(0, fromGroup.stats.directMemories - 1),
        },
      });

      this.store.updateGroup(toGroupId, {
        memoryIds: [...toGroup.memoryIds, memoryId],
        stats: {
          ...toGroup.stats,
          totalMemories: toGroup.stats.totalMemories + 1,
          directMemories: toGroup.stats.directMemories + 1,
        },
      });

      const newGroupIds = memory.groupIds.filter(g => g !== fromGroupId);
      if (!newGroupIds.includes(toGroupId)) newGroupIds.push(toGroupId);
      this.store.updateMemory(memoryId, { groupIds: newGroupIds });
    });
  }

  // ─── Governance: edit / retire ───

  /** True when the memory carries a retirement marker. */
  isRetired(mem: MemoryNode): boolean {
    return this.getRetirement(mem) !== undefined;
  }

  getRetirement(mem: MemoryNode): KBRetirement | undefined {
    const r = mem.metadata?.[KB_RETIRED_KEY];
    return r && typeof r === 'object' ? r as KBRetirement : undefined;
  }

  /** Earlier versions, oldest first. Empty for a memory that was never edited. */
  getHistory(mem: MemoryNode): KBRevision[] {
    const h = mem.metadata?.[KB_HISTORY_KEY];
    return Array.isArray(h) ? h as KBRevision[] : [];
  }

  getVersion(mem: MemoryNode): number {
    const v = mem.metadata?.[KB_VERSION_KEY];
    return typeof v === 'number' && v >= 1 ? v : 1;
  }

  /**
   * Memories with this title in a group or any of its descendants.
   *
   * Descendants too: `addMemoryMaintained` splits a full group into structural subgroups, so a node
   * written into `project/x` last week may now live one level down. Looking only at the direct
   * members would miss it and a "same title" check would quietly create a duplicate.
   * Titles compare case-insensitively with whitespace collapsed. Retired nodes are skipped unless
   * asked for.
   */
  findByTitle(groupId: string, title: string, opts?: { includeRetired?: boolean }): MemoryNode[] {
    const want = normalizeTitle(title);
    const out: MemoryNode[] = [];
    const seenGroups = new Set<string>();
    const seenMems = new Set<string>();
    const stack = [groupId];
    while (stack.length) {
      const gid = stack.pop()!;
      if (seenGroups.has(gid)) continue;
      seenGroups.add(gid);
      const group = this.store.getGroup(gid);
      if (!group) continue;
      for (const mem of this.store.getMemoriesByGroup(gid)) {
        if (seenMems.has(mem.id)) continue;
        seenMems.add(mem.id);
        if (normalizeTitle(mem.title) !== want) continue;
        if (!opts?.includeRetired && this.isRetired(mem)) continue;
        out.push(mem);
      }
      stack.push(...group.childGroupIds);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Edit a memory in place, keeping the version it replaces.
   *
   * The node keeps its id, groups and edges — links that point at it stay valid, which is the
   * point of editing rather than adding a correction node next to a wrong one. The replaced
   * version goes into `metadata.kbHistory` (newest `KB_HISTORY_MAX` kept), so an edit is never
   * a silent overwrite. A patch that changes nothing writes nothing.
   */
  reviseMemory(id: string, patch: KBMemoryPatch, reason?: string): KBReviseResult {
    return this.store.transaction(() => {
      const before = this.store.getMemory(id);
      if (!before) throw new Error(`Memory not found: ${id}`);

      const changed: KBReviseResult['changed'] = [];
      if (patch.title !== undefined && patch.title !== before.title) changed.push('title');
      if (patch.content !== undefined && patch.content !== before.content) changed.push('content');
      if (patch.kind !== undefined && patch.kind !== before.kind) changed.push('kind');
      const version = this.getVersion(before);
      if (changed.length === 0) return { before, after: before, changed, version };

      const revision: KBRevision = {
        at: Date.now(),
        version,
        kind: before.kind,
        title: before.title,
        content: before.content,
        ...(reason ? { reason } : {}),
      };
      const history = [...this.getHistory(before), revision].slice(-KB_HISTORY_MAX);
      const after = this.store.updateMemory(id, {
        title: patch.title ?? before.title,
        content: patch.content ?? before.content,
        kind: patch.kind ?? before.kind,
        metadata: { ...before.metadata, [KB_HISTORY_KEY]: history, [KB_VERSION_KEY]: version + 1 },
      });
      return { before, after, changed, version: version + 1 };
    });
  }

  /**
   * Take a memory out of retrieval without deleting it.
   *
   * A retired node is skipped by `query` unless `includeRetired` is passed, keeps its text,
   * history and edges, and comes back with `restoreMemory`. `replacedBy` names the node that
   * supersedes it, so whoever finds the retired one later is pointed at the current answer.
   */
  retireMemory(id: string, opts: { reason: string; replacedBy?: string }): MemoryNode {
    return this.store.transaction(() => {
      const mem = this.store.getMemory(id);
      if (!mem) throw new Error(`Memory not found: ${id}`);
      const reason = (opts.reason ?? '').trim();
      if (!reason) throw new Error('A reason is required to retire a memory');
      if (opts.replacedBy !== undefined) {
        if (opts.replacedBy === id) throw new Error('A memory cannot replace itself');
        if (!this.store.getMemory(opts.replacedBy)) throw new Error(`Replacement memory not found: ${opts.replacedBy}`);
      }
      const retirement: KBRetirement = {
        at: Date.now(),
        reason,
        ...(opts.replacedBy ? { replacedBy: opts.replacedBy } : {}),
      };
      return this.store.updateMemory(id, { metadata: { ...mem.metadata, [KB_RETIRED_KEY]: retirement } });
    });
  }

  /** Undo `retireMemory`. A memory that is not retired is returned unchanged. */
  restoreMemory(id: string): MemoryNode {
    return this.store.transaction(() => {
      const mem = this.store.getMemory(id);
      if (!mem) throw new Error(`Memory not found: ${id}`);
      if (!this.isRetired(mem)) return mem;
      const { [KB_RETIRED_KEY]: _retired, ...rest } = mem.metadata ?? {};
      return this.store.updateMemory(id, { metadata: rest });
    });
  }

  // ─── Edge management ───

  addWeakEdge(sourceId: string, targetId: string): Edge {
    return this.store.transaction(() => {
      const edge = this.store.createEdge({
        kind: 'weak',
        sourceId,
        targetId,
        weight: 0.5,
        direction: 'bidirectional',
      });

      this.registerEdgeOnGroups(edge, 'weak');
      return edge;
    });
  }

  addCrossGroupEdge(sourceGroupId: string, targetGroupId: string): Edge {
    return this.store.transaction(() => {
      const edge = this.store.createEdge({
        kind: 'cross_group',
        sourceId: sourceGroupId,
        targetId: targetGroupId,
        weight: 1.0,
        direction: 'bidirectional',
      });

      const source = this.store.getGroup(sourceGroupId);
      if (source) {
        this.store.updateGroup(sourceGroupId, {
          crossGroupEdgeIds: [...source.crossGroupEdgeIds, edge.id],
        });
      }
      const target = this.store.getGroup(targetGroupId);
      if (target) {
        this.store.updateGroup(targetGroupId, {
          crossGroupEdgeIds: [...target.crossGroupEdgeIds, edge.id],
        });
      }

      return edge;
    });
  }

  addCoOccurrenceEdge(sourceId: string, targetId: string): Edge {
    return this.store.transaction(() => {
      const edge = this.store.createEdge({
        kind: 'co_occurrence',
        sourceId,
        targetId,
        weight: 0.7,
        direction: 'bidirectional',
      });
      this.registerEdgeOnGroups(edge, 'co_occurrence');
      return edge;
    });
  }

  addTemporalEdge(sourceId: string, targetId: string): Edge {
    return this.store.transaction(() => {
      const edge = this.store.createEdge({
        kind: 'temporal',
        sourceId,
        targetId,
        weight: 0.8,
        direction: 'forward',
      });
      this.registerEdgeOnGroups(edge, 'temporal');
      return edge;
    });
  }

  /**
   * Causal-candidate edge: REQUIRES non-empty evidence AND at least one falsifier.
   * This is NON-NEGOTIABLE. Co-occurrence and temporal edges are NEVER
   * auto-promoted to causal.
   */
  addCausalCandidateEdge(
    sourceId: string,
    targetId: string,
    evidence: string,
    falsifiers: string[],
  ): Edge {
    if (!evidence || evidence.trim().length === 0) {
      throw new Error('causal_candidate edge REQUIRES non-empty evidence');
    }
    if (!falsifiers || falsifiers.length === 0) {
      throw new Error('causal_candidate edge REQUIRES at least one falsifier');
    }

    return this.store.transaction(() => {
      const edge = this.store.createEdge({
        kind: 'causal_candidate',
        sourceId,
        targetId,
        weight: 1.0,
        direction: 'forward',
        evidence,
        falsifiers,
      });
      this.registerEdgeOnGroups(edge, 'causal_candidate');
      return edge;
    });
  }

  addTypedEdge(
    sourceId: string,
    targetId: string,
    kind: EdgeKind,
    options?: { evidence?: string; falsifiers?: string[]; weight?: number },
  ): Edge {
    if (!this.store.getMemory(sourceId)) {
      throw new Error(`kb_link: 源节点不存在 (${sourceId})`);
    }
    if (!this.store.getMemory(targetId)) {
      throw new Error(`kb_link: 目标节点不存在 (${targetId})`);
    }
    if (kind === 'causal_candidate') {
      return this.addCausalCandidateEdge(
        sourceId, targetId,
        options?.evidence ?? '',
        options?.falsifiers ?? [],
      );
    }
    if (kind === 'temporal') return this.addTemporalEdge(sourceId, targetId);
    if (kind === 'co_occurrence') return this.addCoOccurrenceEdge(sourceId, targetId);
    if (kind === 'weak') return this.addWeakEdge(sourceId, targetId);
    if (kind === 'cross_group') return this.addCrossGroupEdge(sourceId, targetId);

    return this.store.transaction(() => {
      const edge = this.store.createEdge({
        kind,
        sourceId,
        targetId,
        weight: options?.weight ?? 1.0,
        direction: 'bidirectional',
      });
      this.registerEdgeOnGroups(edge, kind);
      return edge;
    });
  }

  private registerEdgeOnGroups(edge: Edge, kind: EdgeKind): void {
    if (kind === 'weak') {
      const sourceMemory = this.store.getMemory(edge.sourceId);
      if (sourceMemory) {
        for (const gid of sourceMemory.groupIds) {
          const g = this.store.getGroup(gid);
          if (g && !g.weakEdgeIds.includes(edge.id)) {
            this.store.updateGroup(gid, { weakEdgeIds: [...g.weakEdgeIds, edge.id] });
          }
        }
      }
      const targetMemory = this.store.getMemory(edge.targetId);
      if (targetMemory) {
        for (const gid of targetMemory.groupIds) {
          const g = this.store.getGroup(gid);
          if (g && !g.weakEdgeIds.includes(edge.id)) {
            this.store.updateGroup(gid, { weakEdgeIds: [...g.weakEdgeIds, edge.id] });
          }
        }
      }
    }
  }

  // ─── Competition subgroups ───

  createCompetitionSubgroup(parentId: string, name: string): Group {
    return this.store.transaction(() => {
      const parent = this.store.getGroup(parentId);
      if (!parent) throw new Error(`Parent group not found: ${parentId}`);

      const sub = this.store.createGroup({
        name,
        parentGroupId: parentId,
      });

      this.store.updateGroup(sub.id, { isCompetitionSubgroup: true });

      this.store.updateGroup(parentId, {
        competitionSubgroupIds: [...parent.competitionSubgroupIds, sub.id],
        childGroupIds: [...parent.childGroupIds, sub.id],
        stats: { ...parent.stats, totalChildren: parent.stats.totalChildren + 1 },
      });

      return this.store.getGroup(sub.id)!;
    });
  }

  resolveCompetition(groupId: string, contextHint: string): Group | undefined {
    const group = this.store.getGroup(groupId);
    if (!group) return undefined;

    const subgroups = group.competitionSubgroupIds
      .map(id => this.store.getGroup(id))
      .filter((g): g is Group => g !== undefined);

    if (subgroups.length === 0) return undefined;

    const contextTokens = new Set(tokenize(contextHint));
    let bestGroup: Group | undefined;
    let bestScore = -1;

    for (const sub of subgroups) {
      let score = 0;

      const nameTokens = tokenize(sub.name);
      for (const t of nameTokens) {
        if (contextTokens.has(t)) score += 2;
      }

      for (const memId of sub.memoryIds) {
        const mem = this.store.getMemory(memId);
        if (!mem) continue;
        const memTokens = tokenize(mem.title + ' ' + mem.content);
        for (const t of memTokens) {
          if (contextTokens.has(t)) score += 1;
        }
      }

      score *= sub.hormoneMarker * sub.trustConstant;

      if (score > bestScore) {
        bestScore = score;
        bestGroup = sub;
      }
    }

    return bestGroup ?? subgroups[0];
  }

  // ─── Dormancy (用进废退) ───

  markDormant(memoryId: string): void {
    this.store.updateMemory(memoryId, { isDormant: true });
  }

  activateMemory(memoryId: string): void {
    this.store.boostAccess(memoryId);
    this.store.updateMemory(memoryId, { isDormant: false });
  }

  getDormancyRatio(groupId: string): number {
    const group = this.store.getGroup(groupId);
    if (!group || group.memoryIds.length === 0) return 0;

    let dormant = 0;
    for (const memId of group.memoryIds) {
      const mem = this.store.getMemory(memId);
      if (mem?.isDormant) dormant++;
    }

    return dormant / group.memoryIds.length;
  }

  compressDormant(groupId: string): MemoryNode | undefined {
    return this.store.transaction(() => {
      const group = this.store.getGroup(groupId);
      if (!group) throw new Error(`Group not found: ${groupId}`);

      const thresholdMs = this.config.dormancyThresholdDays * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - thresholdMs;

      const dormantMems: MemoryNode[] = [];
      for (const memId of group.memoryIds) {
        const mem = this.store.getMemory(memId);
        if (mem && mem.isDormant && mem.lastAccessedAt < cutoff) {
          dormantMems.push(mem);
        }
      }

      if (dormantMems.length < 2) return undefined;

      const titles = dormantMems.map(m => m.title).join(', ');
      const contentSummary = dormantMems
        .map(m => `[${m.title}]: ${m.content}`)
        .join('\n---\n');

      const summary = this.store.createMemory({
        kind: 'text',
        title: `[compressed] ${titles}`,
        content: contentSummary,
        metadata: {
          compressed: true,
          sourceIds: dormantMems.map(m => m.id),
          sourceCount: dormantMems.length,
        },
        groupIds: [groupId],
      });

      const remainingMemIds = group.memoryIds.filter(
        id => !dormantMems.some(dm => dm.id === id),
      );
      remainingMemIds.push(summary.id);

      for (const dm of dormantMems) {
        this.store.deleteMemory(dm.id);
      }

      this.store.updateGroup(groupId, {
        memoryIds: remainingMemIds,
        stats: {
          ...group.stats,
          totalMemories: remainingMemIds.length,
          directMemories: remainingMemIds.length,
          compressedMemories: group.stats.compressedMemories + 1,
        },
      });

      return summary;
    });
  }

  // ─── PulseSeed Retrieval (structural resonance, NOT RAG) ───

  // ─── Hybrid retrieval: structural resonance + traditional lexical IR ───

  /** Weight of the structural (PulseSeed) channel in the fused score. */
  private static readonly W_STRUCTURAL = 0.55;
  /** Weight of the lexical (BM25) channel in the fused score. */
  private static readonly W_LEXICAL = 0.45;

  /**
   * Scale applied to nodes matched by a precision anchor (explicit `@group:` /
   * `#title` / node id, or a group name/path).
   *
   * Required for anchors to actually rank first: seed energy alone was not
   * enough, because propagation lifts neighbours above them. Measured on the
   * real library, group-name queries put the right group first 8/8 times with
   * this and only 5/8 without it — the system prompt tells the model to search
   * by group name, so precision here is what makes retrieval feel intelligent.
   *
   * Note this does not make `final` exceed 1 on its own; scores above 1 come
   * from `computeSignalBoost` and predate this change.
   */
  private static readonly ANCHOR_BONUS = 3.5;

  /**
   * Structural signals that should move a node up or down regardless of
   * whether it surfaced via resonance or via BM25.
   */
  private computeSignalBoost(mem: MemoryNode): { boost: number; notes: string[] } {
    const notes: string[] = [];
    let boost = 1;

    // 用进废退 — frequently recalled knowledge ranks higher.
    if (mem.accessCount > 0) {
      const useBoost = 1 + Math.log1p(mem.accessCount) * 0.12;
      boost *= useBoost;
      notes.push(`use×${useBoost.toFixed(2)}`);
    }

    // Group reliability / priority markers.
    let trust = 1;
    let hormone = 1;
    for (const gid of mem.groupIds) {
      const g = this.store.getGroup(gid);
      if (!g) continue;
      trust = Math.max(trust, g.trustConstant);
      hormone = Math.max(hormone, g.hormoneMarker);
    }
    const trustC = Math.min(2, Math.max(0.5, trust));
    const hormoneC = Math.min(2, Math.max(0.5, hormone));
    if (trustC !== 1) { boost *= trustC; notes.push(`trust×${trustC.toFixed(2)}`); }
    if (hormoneC !== 1) { boost *= hormoneC; notes.push(`hormone×${hormoneC.toFixed(2)}`); }

    // Gentle recency preference (fresh knowledge is usually more relevant).
    const ageDays = (Date.now() - (mem.updatedAt || mem.createdAt)) / 86_400_000;
    boost *= 0.85 + 0.15 * Math.exp(-ageDays / 120);

    // Dormant knowledge is demoted, never hidden.
    if (mem.isDormant) { boost *= 0.6; notes.push('dormant×0.60'); }

    return { boost, notes };
  }

  /**
   * Query the KB using hybrid retrieval.
   *
   * 1. Lexical channel: BM25 over title + content (traditional IR precision).
   * 2. Structural channel: those hits + explicit anchors become entry points,
   *    and PulseSeeds propagate through the group graph (relationship recall).
   * 3. Fusion: normalized structural + lexical score, multiplied by structural
   *    signals (trust / hormone / 用进废退 / recency / dormancy).
   * 4. Every result still carries an activation trace explaining its score.
   */
  query(
    queryText: string,
    options?: { budget?: number; includeRetired?: boolean },
  ): KBQueryResult {
    const startTime = performance.now();
    // Retired memories are out of retrieval unless asked for (see `retireMemory`). They are
    // dropped as entry points and as results; nothing else about the scoring changes.
    const includeRetired = options?.includeRetired === true;
    const hidden = (mem: MemoryNode): boolean => !includeRetired && this.isRetired(mem);
    const budget = options?.budget ?? this.config.activationBudget;
    const psConfig = this.config.pulseSeed;

    // ── Channel A: traditional lexical ranking ──
    const lexicalHits = this.store.bm25Search(queryText, { limit: Math.max(3, Math.min(80, budget)) })
      .filter((h) => !hidden(h.mem));
    const lexicalById = new Map<string, number>(lexicalHits.map((h) => [h.mem.id, h.score]));

    // ── Channel B: structural resonance ──
    // Explicit anchors first (highest-precision entry points), then lexical hits.
    // Fuzzy substring matches are deliberately NOT treated as anchors here —
    // BM25 already ranks them, and the seed weighting below reflects that.
    const anchorNodes = this.store.findExplicitAnchors(queryText);

    /**
     * Group-name anchors.
     *
     * `findExplicitAnchors` only recognises the `@group:name` syntax, and BM25
     * indexes memory text — not group names. So a plain group name like
     * `ops/kb-connectivity` matched nothing structurally, and the retrieval
     * advice in the system prompt ("try the group name instead") silently did
     * not work: measured against a real library, querying by group path put
     * another group's content first.
     *
     * A group whose name (or full path) equals or is contained in the query now
     * seeds its own memories at anchor strength.
     */
    const groupAnchors: MemoryNode[] = [];
    {
      const q = queryText.trim().toLowerCase();
      if (q) {
        const groupById = new Map(this.store.getAllGroups().map((g) => [g.id, g]));
        const groupPath = (id: string): string => {
          const parts: string[] = [];
          let cur = groupById.get(id);
          let guard = 0;
          while (cur && guard++ < 32) {
            parts.unshift(cur.name);
            cur = cur.parentGroupId ? groupById.get(cur.parentGroupId) : undefined;
          }
          return parts.join('/').toLowerCase();
        };
        for (const g of this.store.getAllGroups()) {
          const name = g.name.toLowerCase();
          const path = groupPath(g.id);
          // Path segments, including hyphenated words (`agent-usability` →
          // agent, usability). A query of one of those words is how people
          // look up a group; requiring the full path returned nothing.
          const segments = new Set<string>();
          for (const part of path.split('/')) {
            if (part.length >= 2) segments.add(part);
            for (const bit of part.split(/[-_.]+/)) {
              if (bit.length >= 3) segments.add(bit);
            }
          }
          const qTokens = q.split(/[\s,/]+/).flatMap((t) => t.split(/[-_.]+/)).filter((t) => t.length >= 3);
          const tokenHit = qTokens.some((t) => segments.has(t));
          const isAnchor = q === name || q === path
            || q.endsWith('/' + name) || path.endsWith('/' + q)
            || q.includes(path)
            || tokenHit;
          if (!isAnchor) continue;
          for (const mem of this.store.getMemoriesByGroup(g.id)) groupAnchors.push(mem);
        }
      }
    }

    const anchorIds = new Set([...anchorNodes, ...groupAnchors].map((n) => n.id));
    const seeds: MemoryNode[] = [];
    const seenSeed = new Set<string>();
    for (const node of [...anchorNodes, ...groupAnchors, ...lexicalHits.map((h) => h.mem)]) {
      if (seenSeed.has(node.id) || hidden(node)) continue;
      seenSeed.add(node.id);
      seeds.push(node);
    }

    // Seed energy is proportional to how well the seed actually matched.
    // Giving every seed full energy let a document that merely shared a common
    // word flood the structure with the same activation as an exact hit.
    let maxSeedLex = 0;
    for (const h of lexicalHits) if (h.score > maxSeedLex) maxSeedLex = h.score;
    const SEED_ENERGY_FLOOR = 0.12;
    const seedWeight = (nodeId: string): number => {
      if (anchorIds.has(nodeId)) return 1;
      if (maxSeedLex <= 0) return SEED_ENERGY_FLOOR;
      const lex = lexicalById.get(nodeId) ?? 0;
      return Math.max(SEED_ENERGY_FLOOR, Math.min(1, lex / maxSeedLex));
    };

    const allPulseSeeds: PulseSeed[] = [];
    const activationMap = new Map<string, number>();
    const nodeSeeds = new Map<string, PulseSeed[]>();
    const groupsVisited = new Set<string>();
    // Mutable work counter shared with the propagation so `budget` is a real
    // ceiling (previously it was overwritten by an unrelated map size).
    const counter = { n: 0 };

    for (const seedNode of seeds) {
      if (counter.n >= budget) break;
      counter.n++;

      const sourceGroupId = seedNode.groupIds[0] ?? '__root__';
      const seedEnergy = psConfig.initialEnergy * seedWeight(seedNode.id);

      const pulse: PulseSeed = {
        id: `ps-${seedNode.id.slice(0, 8)}`,
        sourceNodeId: seedNode.id,
        sourceGroupId,
        energy: seedEnergy,
        origin: queryText,
        hop: 0,
        path: [],
        resonatedAt: Date.now(),
      };

      allPulseSeeds.push(pulse);
      // Never lower an activation that propagation already raised: a node can
      // be both a seed and a neighbour of another seed.
      activationMap.set(seedNode.id, Math.max(activationMap.get(seedNode.id) ?? 0, seedEnergy));
      nodeSeeds.set(seedNode.id, [pulse]);

      for (const gid of seedNode.groupIds) {
        groupsVisited.add(gid);
      }

      this.propagatePulse(
        pulse, seedNode.id, seedEnergy, 0,
        activationMap, nodeSeeds, groupsVisited,
        counter, budget, psConfig,
        new Set<string>([seedNode.id]),
      );
    }

    // ── Fusion ──
    const candidateIds = new Set<string>([...activationMap.keys(), ...lexicalById.keys()]);
    let maxAct = 0;
    for (const v of activationMap.values()) if (v > maxAct) maxAct = v;
    let maxLex = 0;
    for (const v of lexicalById.values()) if (v > maxLex) maxLex = v;

    const scored: {
      mem: MemoryNode;
      activation: number;
      lexical: number;
      final: number;
      boost: number;
      notes: string[];
      seeds: PulseSeed[];
    }[] = [];

    for (const nodeId of candidateIds) {
      const mem = this.store.getMemory(nodeId);
      if (!mem || hidden(mem)) continue;

      const activation = activationMap.get(nodeId) ?? 0;
      const lexical = lexicalById.get(nodeId) ?? 0;

      // A node with neither signal is not a result.
      if (activation <= 0 && lexical <= 0) continue;

      const structPart = maxAct > 0 ? activation / maxAct : 0;
      const lexPart = maxLex > 0 ? lexical / maxLex : 0;
      const base =
        GroupKBEngine.W_STRUCTURAL * structPart +
        GroupKBEngine.W_LEXICAL * lexPart;
      // An anchor with no fused signal at all is still worth surfacing (a group
      // name can legitimately share no tokens with its contents).
      if (base <= 0 && !anchorIds.has(nodeId)) continue;

      // Anchors rank first — see ANCHOR_BONUS for the measured effect.
      const anchorWeight = anchorIds.has(nodeId) ? GroupKBEngine.ANCHOR_BONUS : 1;

      const { boost, notes } = this.computeSignalBoost(mem);
      scored.push({
        mem,
        activation,
        lexical,
        final: base * boost * anchorWeight,
        boost,
        notes,
        seeds: nodeSeeds.get(nodeId) ?? [],
      });
    }

    scored.sort((a, b) => b.final - a.final || a.mem.createdAt - b.mem.createdAt);

    // Absolute relevance floor (independent of the top hit, so a larger budget
    // can only ever ADD results — never remove them).
    const relevanceFloor = Math.max(0.05, psConfig.resonanceThreshold * 0.5);
    const MAX_RESULTS = 40;

    const nodes: MemoryNode[] = [];
    const traces: ActivationTrace[] = [];

    for (const entry of scored) {
      if (nodes.length >= MAX_RESULTS) break;
      if (entry.final < relevanceFloor) continue;

      const mem = entry.mem;
      // Reinforce the nodes we actually surface (bounded, to avoid a runaway
      // feedback loop where every query inflates its own top hits).
      if (nodes.length < 10) this.store.boostAccess(mem.id);
      nodes.push(mem);

      const memGroups = mem.groupIds
        .map((gid) => this.store.getGroup(gid))
        .filter((g): g is Group => g !== undefined);

      const seedCount = entry.seeds.length;
      const hopSummary = entry.seeds.map((s) => `${s.path.length} hops`).join(', ');
      const parts: string[] = [
        seedCount > 0
          ? `structural resonance via ${seedCount} PulseSeed(s): ${hopSummary || 'direct'}`
          : 'no structural activation',
      ];
      if (entry.lexical > 0) parts.push(`lexical BM25 ${entry.lexical.toFixed(2)}`);
      if (entry.notes.length) parts.push(entry.notes.join(', '));

      traces.push({
        nodeId: mem.id,
        groupPath: memGroups.length ? memGroups.map((g) => this.buildGroupPath(g)) : ['(ungrouped)'],
        pulseSeeds: entry.seeds,
        activationLevel: entry.activation,
        reason: parts.join(' · '),
        lexicalScore: entry.lexical,
        finalScore: entry.final,
        signalBoost: entry.boost,
        signalNotes: entry.notes,
      });
    }

    return {
      nodes,
      traces,
      groupsVisited: [...groupsVisited],
      totalNodesScanned: counter.n,
      queryTimeMs: performance.now() - startTime,
      pulseSeeds: allPulseSeeds,
    };
  }

  private propagatePulse(
    rootPulse: PulseSeed,
    currentNodeId: string,
    energy: number,
    hop: number,
    activationMap: Map<string, number>,
    nodeSeeds: Map<string, PulseSeed[]>,
    groupsVisited: Set<string>,
    counter: { n: number },
    budget: number,
    psConfig: SheConfig['kb']['pulseSeed'],
    visited: Set<string>,
  ): void {
    if (energy < psConfig.resonanceThreshold) return;
    if (hop >= psConfig.maxHops) return;
    if (counter.n >= budget) return;
    counter.n++;

    const nextEnergy = energy * (1 - psConfig.decayRate);
    const dormancyGate = psConfig.resonanceThreshold * 2;

    const currentMem = this.store.getMemory(currentNodeId);
    if (currentMem) {
      for (const gid of currentMem.groupIds) {
        const group = this.store.getGroup(gid);
        if (!group) continue;
        groupsVisited.add(gid);

        if (group.isDormant && energy < dormancyGate) continue;

        for (const sibMemId of group.memoryIds) {
          if (visited.has(sibMemId)) continue;
          const sibMem = this.store.getMemory(sibMemId);
          if (!sibMem) continue;
          if (sibMem.isDormant && energy < dormancyGate) continue;

          visited.add(sibMemId);
          const sibEnergy = nextEnergy * 0.7;

          const hopRecord: PulseHop = {
            fromId: currentNodeId,
            toId: sibMemId,
            edgeId: null,
            edgeKind: 'group_member',
            energyBefore: energy,
            energyAfter: sibEnergy,
          };

          const childPulse: PulseSeed = {
            ...rootPulse,
            id: `${rootPulse.id}-h${hop + 1}-${sibMemId.slice(0, 6)}`,
            energy: sibEnergy,
            hop: hop + 1,
            path: [...rootPulse.path, hopRecord],
            resonatedAt: Date.now(),
          };

          const existing = activationMap.get(sibMemId) ?? 0;
          activationMap.set(sibMemId, Math.max(existing, sibEnergy));

          const existingSeeds = nodeSeeds.get(sibMemId) ?? [];
          existingSeeds.push(childPulse);
          nodeSeeds.set(sibMemId, existingSeeds);

          for (const sg of sibMem.groupIds) groupsVisited.add(sg);
        }

        if (group.parentGroupId) {
          const parent = this.store.getGroup(group.parentGroupId);
          if (parent && !parent.isDormant) {
            groupsVisited.add(parent.id);
            for (const sibGroupId of parent.childGroupIds) {
              if (sibGroupId === gid) continue;
              const sibGroup = this.store.getGroup(sibGroupId);
              if (!sibGroup || sibGroup.isDormant) continue;
              groupsVisited.add(sibGroupId);

              const hierEnergy = nextEnergy * 0.5;
              for (const memId of sibGroup.memoryIds.slice(0, 3)) {
                if (visited.has(memId)) continue;
                const mem = this.store.getMemory(memId);
                if (!mem || mem.isDormant) continue;
                visited.add(memId);

                const hopR: PulseHop = {
                  fromId: currentNodeId,
                  toId: memId,
                  edgeId: null,
                  edgeKind: 'parent_child',
                  energyBefore: energy,
                  energyAfter: hierEnergy,
                };

                const existing = activationMap.get(memId) ?? 0;
                activationMap.set(memId, Math.max(existing, hierEnergy));

                const hp: PulseSeed = {
                  ...rootPulse,
                  id: `${rootPulse.id}-hier-${memId.slice(0, 6)}`,
                  energy: hierEnergy,
                  hop: hop + 1,
                  path: [...rootPulse.path, hopR],
                  resonatedAt: Date.now(),
                };

                const es = nodeSeeds.get(memId) ?? [];
                es.push(hp);
                nodeSeeds.set(memId, es);
              }
            }
          }
        }
      }
    }

    const edges = this.store.getEdgesForNode(currentNodeId);
    for (const edge of edges) {
      const neighborId = edge.sourceId === currentNodeId ? edge.targetId : edge.sourceId;

      if (edge.direction === 'forward' && edge.targetId === currentNodeId) continue;
      if (edge.direction === 'backward' && edge.sourceId === currentNodeId) continue;

      if (visited.has(neighborId)) continue;
      visited.add(neighborId);

      const edgeEnergy = nextEnergy * edge.weight;
      if (edgeEnergy < psConfig.resonanceThreshold) continue;

      const neighborMem = this.store.getMemory(neighborId);
      if (neighborMem) {
        if (neighborMem.isDormant && edgeEnergy < dormancyGate) continue;

        const hopR: PulseHop = {
          fromId: currentNodeId,
          toId: neighborId,
          edgeId: edge.id,
          edgeKind: edge.kind,
          energyBefore: energy,
          energyAfter: edgeEnergy,
        };

        const existing = activationMap.get(neighborId) ?? 0;
        activationMap.set(neighborId, Math.max(existing, edgeEnergy));

        const ep: PulseSeed = {
          ...rootPulse,
          id: `${rootPulse.id}-e-${neighborId.slice(0, 6)}`,
          energy: edgeEnergy,
          hop: hop + 1,
          path: [...rootPulse.path, hopR],
          resonatedAt: Date.now(),
        };

        const es = nodeSeeds.get(neighborId) ?? [];
        es.push(ep);
        nodeSeeds.set(neighborId, es);

        for (const gid of neighborMem.groupIds) groupsVisited.add(gid);

        this.propagatePulse(
          ep, neighborId, edgeEnergy, hop + 1,
          activationMap, nodeSeeds, groupsVisited,
          counter, budget, psConfig, visited,
        );
      }
    }
  }

  private buildGroupPath(group: Group): string {
    const path: string[] = [group.name];
    let current = group;
    const seen = new Set<string>([group.id]);
    while (current.parentGroupId) {
      // Guard against a malformed parent chain (would otherwise spin forever).
      if (seen.has(current.parentGroupId)) break;
      const parent = this.store.getGroup(current.parentGroupId);
      if (!parent) break;
      seen.add(parent.id);
      path.unshift(parent.name);
      current = parent;
    }
    return path.join(' \u2192 ');
  }

  // ─── Ingestion ───

  ingestFile(filePath: string, rootGroupId?: string): MemoryNode {
    const content = readFileSync(filePath, 'utf-8');
    const ext = extname(filePath).toLowerCase();
    const kind: MemoryNode['kind'] = CODE_EXTENSIONS.has(ext) ? 'code' : 'text';
    const title = basename(filePath);

    const groupId = rootGroupId ?? this.getOrCreateRootGroup().id;

    return this.addMemoryMaintained(groupId, kind, title, content, {
      filePath,
      extension: ext,
      size: content.length,
    });
  }

  ingestDirectory(dirPath: string, rootGroupId?: string): void {
    const rootGroup = rootGroupId
      ? this.store.getGroup(rootGroupId) ?? this.createGroup(basename(dirPath))
      : this.createGroup(basename(dirPath));

    this.walkDirectory(dirPath, rootGroup.id);
  }

  private walkDirectory(dirPath: string, groupId: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') continue;

      const fullPath = join(dirPath, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        const subGroup = this.createGroup(entry, groupId);
        this.walkDirectory(fullPath, subGroup.id);
      } else if (stat.isFile()) {
        try {
          this.ingestFile(fullPath, groupId);
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  private getOrCreateRootGroup(): Group {
    const allGroups = this.store.getAllGroups();
    const root = allGroups.find(g => g.parentGroupId === null && g.name === '__root__');
    if (root) return root;
    return this.store.createGroup({ name: '__root__' });
  }
}
