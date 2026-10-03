import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type {
  Group,
  MemoryNode,
  Edge,
  EdgeKind,
  KBQueryResult,
  KBQueryDiagnostics,
  RetrievalChannel,
  ActivationTrace,
  PulseSeed,
  PulseHop,
  SheConfig,
} from '@she/shared';
import { KBStore, tokenizeQuery } from './store.js';
import type { CreateEdgeInput } from './store.js';
import { queryTerms, groupConcepts, fallbackUnits, unitMatches, idTokens } from './retrieval-lexicon.js';
import type { WeightedTerm } from './retrieval-lexicon.js';

/**
 * A result the primary pass could not find with confidence, found by the broader fallback pass
 * (fragment overlap — CJK bigrams, Latin words by prefix). Kept apart from `nodes` on purpose: a caller that shows them must
 * label them, and a caller that only reads `nodes` gets exactly the confident results it always did.
 */
export interface KBFallbackResult {
  nodes: MemoryNode[];
  traces: ActivationTrace[];
  /** Why the fallback ran, in words a reader can act on. */
  reason: string;
}

/** `KBQueryResult` plus the fallback pass. */
export interface KBQueryResultWithFallback extends KBQueryResult {
  fallback?: KBFallbackResult;
}

/** A group's derived vocabulary (see `groupConcepts`), cached per store generation. */
interface GroupVocabulary {
  generation: number;
  groups: Map<string, Map<string, { weight: number; term: string; source: 'name' | 'ancestor' | 'members' }>>;
  /** How many groups carry each concept — rarer concepts route more sharply. */
  conceptGroups: Map<string, number>;
}


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

// ─── Split parts ───
//
// `splitGroup` turns an overfull group into structural children named `${group.name}/part-N`.
// Those parts are storage buckets, not topics: agents must write to the logical group, and a part
// must never split again into `part-3/part-1` (that breaks the one-level co-membership hop).

/** Minimal group shape the split-part helpers need, so store-like callers can use them too. */
export interface SplitPartGroupLike {
  id: string;
  name: string;
  parentGroupId: string | null;
}

/** True when `child` is a synthetic split part of `parent`, i.e. named `${parent.name}/part-<n>`. */
export function isSplitPartOf(child: { name: string }, parent: { name: string }): boolean {
  if (!child.name.startsWith(parent.name)) return false;
  return /^\/part-\d+$/.test(child.name.slice(parent.name.length));
}

/**
 * The logical group behind a synthetic split part, walking up through nested parts
 * (`a/part-3/part-1` resolves to `a`). A normal group resolves to itself.
 */
export function resolveLogicalGroup<G extends SplitPartGroupLike>(
  group: G,
  getGroup: (id: string) => G | undefined,
): G {
  let cur = group;
  const seen = new Set<string>([cur.id]);
  while (cur.parentGroupId && !seen.has(cur.parentGroupId)) {
    const parent = getGroup(cur.parentGroupId);
    if (!parent || !isSplitPartOf(cur, parent)) break;
    seen.add(parent.id);
    cur = parent;
  }
  return cur;
}

/** Next unused `${baseName}/part-N` index. Checks every group: names are global lookup keys. */
export function nextSplitPartIndex(baseName: string, allGroups: Array<{ name: string }>): number {
  const prefix = `${baseName}/part-`;
  let max = 0;
  for (const g of allGroups) {
    if (!g.name.startsWith(prefix)) continue;
    const rest = g.name.slice(prefix.length);
    if (/^\d+$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return max + 1;
}

/**
 * Collapse a root-to-leaf chain of group names for display. Group names are usually full paths
 * already (`project/x/part-3` under `project/x` under `project`), so joining every level repeats
 * them; an ancestor whose name the next kept descendant already starts with is dropped.
 * Legacy short names (`arch` under `project`) are kept as separate segments.
 */
export function collapseGroupNameChain(names: string[]): string[] {
  const out: string[] = [];
  for (let i = names.length - 1; i >= 0; i--) {
    const head = out[0];
    if (head !== undefined && head.startsWith(`${names[i]}/`)) continue;
    out.unshift(names[i]);
  }
  return out;
}

function splitPartNumber(name: string): number {
  const m = /\/part-(\d+)$/.exec(name);
  return m ? Number(m[1]) : 0;
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

      // A split part never nests (`part-3/part-1`): its overflow spills into sibling parts.
      if (group.parentGroupId) {
        const logical = resolveLogicalGroup(group, (id) => this.store.getGroup(id));
        if (logical.id !== group.id) return this.spillSplitPart(group, logical);
      }

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
      // Collision-safe: never reuse a part number that already exists under this name.
      const partBase = Math.max(
        group.childGroupIds.length,
        nextSplitPartIndex(group.name, this.store.getAllGroups()) - 1,
      );

      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        if (bucket.length === 0) continue;

        // Number parts by the parent's existing child count so repeated splits
        // produce unique names instead of part-1/part-2/part-3 repeating.
        const partIndex = partBase + i + 1;
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

  /**
   * Overflow of a split part. Direct members beyond the cap (the most recently added) move to
   * sibling parts under the logical parent: first the newest later-numbered sibling part that
   * still has room (an earlier spill), then new `${logical.name}/part-<next unused>` groups.
   * Nothing nests.
   */
  private spillSplitPart(group: Group, logical: Group): Group[] {
    const cap = Math.max(1, group.maxChildrenBeforeSplit);
    const overflow = group.memoryIds.slice(cap);
    if (overflow.length === 0) return [group];

    // Number of the top-level part this group sits in (itself, or its ancestor for legacy nesting).
    let top: Group = group;
    for (let guard = 0; top.parentGroupId && top.parentGroupId !== logical.id && guard < 32; guard++) {
      const up = this.store.getGroup(top.parentGroupId);
      if (!up) break;
      top = up;
    }
    const ownNumber = top.parentGroupId === logical.id ? splitPartNumber(top.name) : 0;
    const siblings = logical.childGroupIds
      .map((id) => this.store.getGroup(id))
      .filter((g): g is Group => g !== undefined && g.id !== group.id
        && g.childGroupIds.length === 0 && isSplitPartOf(g, logical)
        && splitPartNumber(g.name) > ownNumber)
      .sort((a, b) => splitPartNumber(b.name) - splitPartNumber(a.name));
    let target: Group | undefined = siblings[0] && siblings[0].memoryIds.length < cap ? siblings[0] : undefined;
    let nextIndex = nextSplitPartIndex(logical.name, this.store.getAllGroups());
    const childIds = [...logical.childGroupIds];
    const touched = new Map<string, Group>();
    const pending = [...overflow];

    while (pending.length > 0) {
      if (!target || target.memoryIds.length >= cap) {
        target = this.store.createGroup({
          name: `${logical.name}/part-${nextIndex++}`,
          parentGroupId: logical.id,
          maxChildrenBeforeSplit: logical.maxChildrenBeforeSplit,
        });
        childIds.push(target.id);
      }
      const batch = pending.splice(0, cap - target.memoryIds.length);
      this.store.updateGroup(target.id, {
        memoryIds: [...target.memoryIds, ...batch],
        stats: {
          ...target.stats,
          totalMemories: target.stats.totalMemories + batch.length,
          directMemories: target.stats.directMemories + batch.length,
        },
      });
      const targetId = target.id;
      for (const memId of batch) {
        const mem = this.store.getMemory(memId);
        if (!mem) continue;
        const gids = mem.groupIds.filter((g) => g !== group.id && g !== targetId);
        gids.push(targetId);
        this.store.updateMemory(memId, { groupIds: gids });
      }
      target = this.store.getGroup(targetId)!;
      touched.set(target.id, target);
    }

    this.store.updateGroup(group.id, {
      memoryIds: group.memoryIds.slice(0, cap),
      stats: {
        ...group.stats,
        totalMemories: Math.max(0, group.stats.totalMemories - overflow.length),
        directMemories: Math.max(0, group.stats.directMemories - overflow.length),
      },
    });
    const added = childIds.length - logical.childGroupIds.length;
    if (added > 0) {
      this.store.updateGroup(logical.id, {
        childGroupIds: childIds,
        stats: { ...logical.stats, totalChildren: logical.stats.totalChildren + added },
      });
    }
    return [...touched.values()];
  }

  /**
   * The logical group behind a synthetic split part (`<parent>/part-N`, walked up through nested
   * parts). A normal group resolves to itself; an unknown id to undefined.
   */
  resolveLogicalGroup(groupId: string): Group | undefined {
    const group = this.store.getGroup(groupId);
    if (!group) return undefined;
    return resolveLogicalGroup(group, (id) => this.store.getGroup(id));
  }

  /** True when the group is a synthetic split part of some logical group. */
  isSplitPart(groupId: string): boolean {
    const logical = this.resolveLogicalGroup(groupId);
    return logical !== undefined && logical.id !== groupId;
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
   * 融合分的并列判定尺度，见 `query` 里排序处的注释。
   *
   * 1e-6 是"比任何有意义的分数差都小、比浮点噪声大"的那一档：时效项造成的差异在 1e-12 量级，
   * 真实的词法/结构差异在 1e-2 量级。
   */
  private static readonly SCORE_EPSILON = 1e-6;

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
   * Members of a group the query was ROUTED to by concept (see `routeGroups`) are multiplied by
   * `1 + ROUTE_BONUS × route strength` — at most 3, under `ANCHOR_BONUS` (3.5): a group name the
   * user typed is a stronger claim than a concept inferred from their words, so an explicit anchor
   * still wins. Chosen by sweep on `evals/recall` (0.5–2.5; 2 was best on meaning hit@1 with no
   * lexical regression).
   */
  private static readonly ROUTE_BONUS = 2;

  /** Below this share of the query's own (idf-weighted) words, the best hit counts as weak. */
  private static readonly WEAK_COVERAGE = 0.34;

  /** Fallback hits must share at least this idf-weighted share of the query's fragments. */
  private static readonly FALLBACK_MIN = 0.12;

  private vocabulary: GroupVocabulary | null = null;

  /** Every group's concepts, rebuilt only when the store has been written since. */
  private groupVocabulary(): GroupVocabulary {
    const generation = this.store.generation;
    if (this.vocabulary && this.vocabulary.generation === generation) return this.vocabulary;
    const all = this.store.getAllGroups();
    const byId = new Map(all.map((g) => [g.id, g]));
    const groups: GroupVocabulary['groups'] = new Map();
    const conceptGroups = new Map<string, number>();
    for (const g of all) {
      const ancestorNames: string[] = [];
      let cur = g.parentGroupId ? byId.get(g.parentGroupId) : undefined;
      for (let guard = 0; cur && guard < 32; guard++) {
        ancestorNames.push(cur.name);
        cur = cur.parentGroupId ? byId.get(cur.parentGroupId) : undefined;
      }
      const concepts = groupConcepts({
        name: g.name,
        ancestorNames,
        memberTitles: this.store.getMemoriesByGroup(g.id).map((m) => m.title),
      });
      groups.set(g.id, concepts);
      for (const id of concepts.keys()) conceptGroups.set(id, (conceptGroups.get(id) ?? 0) + 1);
    }
    this.vocabulary = { generation, groups, conceptGroups };
    return this.vocabulary;
  }

  /**
   * Route a query to groups by the concepts it names, before any node is scored.
   *
   * This is the structural half of meaning-only retrieval: "如何避免重蹈覆辙" names the `mistake`
   * concept, and `errors` (by name) and every `errors/*` group (by ancestry) are about it — so their
   * members enter as seeds even though none of them contains the word 重蹈覆辙. Score per group is
   * the concept weight times how rare the concept is across groups; only groups within half of the
   * best route are kept, so a concept every group mentions routes nowhere in particular.
   */
  private routeGroups(concepts: { concept: { id: string }; term: string }[]): Map<string, { score: number; why: string }> {
    const out = new Map<string, { score: number; why: string }>();
    if (!concepts.length) return out;
    const vocab = this.groupVocabulary();
    const total = Math.max(1, vocab.groups.size);
    const raw = new Map<string, { score: number; why: string[] }>();
    for (const [gid, gc] of vocab.groups) {
      let score = 0;
      const why: string[] = [];
      for (const hit of concepts) {
        const c = gc.get(hit.concept.id);
        if (!c) continue;
        const rarity = Math.log(1 + total / (vocab.conceptGroups.get(hit.concept.id) ?? 1));
        score += c.weight * rarity;
        why.push(`${hit.term}→${hit.concept.id}${c.source === 'members' ? '（成员标题）' : ''}`);
      }
      if (score > 0) raw.set(gid, { score, why });
    }
    let best = 0;
    for (const r of raw.values()) best = Math.max(best, r.score);
    for (const [gid, r] of raw) {
      if (r.score >= best * 0.5) out.set(gid, { score: r.score / best, why: r.why.join('、') });
    }
    return out;
  }

  /**
   * Idf-weighted share of the query's own words that appear in a node. Measures how well the best
   * hit actually matched — the fused score cannot, because it is normalised to the top hit and so
   * reads ~1.0 for the best of a bad lot.
   */
  private coverage(own: string[], mem: MemoryNode): number {
    if (!own.length) return 1;
    const have = new Set(tokenizeQuery(`${mem.title}\n${mem.content}`));
    let got = 0;
    let all = 0;
    for (const t of own) {
      const w = this.store.termIdf(t);
      all += w;
      if (have.has(t)) got += w;
    }
    return all > 0 ? got / all : 0;
  }

  /**
   * The broader second pass: fragment overlap over every node.
   *
   * Runs only when the primary pass found nothing confident. Coarser than tokens (CJK bigrams, Latin
   * words by shared prefix — `fallbackUnits`) and fed with the query's concept words too, so a
   * paraphrase that shares fragments but not whole words can still surface a candidate. Its results
   * are returned apart from the primary ones and must be shown labelled — they are leads, not answers.
   */
  private fallbackPass(
    queryText: string,
    terms: WeightedTerm[],
    exclude: Set<string>,
    hidden: (mem: MemoryNode) => boolean,
  ): { mem: MemoryNode; score: number; units: string[] }[] {
    const qWeights = new Map<string, number>();
    for (const u of fallbackUnits(queryText, 'query')) qWeights.set(u, 1);
    for (const t of terms) {
      if (!t.via) continue;
      for (const u of fallbackUnits(t.token, 'query')) if (!qWeights.has(u)) qWeights.set(u, 0.5);
    }
    if (!qWeights.size) return [];
    const docs: { mem: MemoryNode; hits: Set<string> }[] = [];
    const seen = new Set<string>();
    const df = new Map<string, number>();
    for (const g of this.store.getAllGroups()) {
      for (const mem of this.store.getMemoriesByGroup(g.id)) {
        if (seen.has(mem.id) || exclude.has(mem.id) || hidden(mem)) continue;
        seen.add(mem.id);
        const units = fallbackUnits(`${mem.title}\n${mem.content}`);
        const hits = new Set<string>();
        for (const q of qWeights.keys()) {
          if (!unitMatches(q, units)) continue;
          hits.add(q);
          df.set(q, (df.get(q) ?? 0) + 1);
        }
        docs.push({ mem, hits });
      }
    }
    if (!docs.length) return [];
    const idf = (u: string) => Math.log(1 + docs.length / (1 + (df.get(u) ?? 0)));
    let denom = 0;
    for (const [u, w] of qWeights) denom += w * idf(u);
    const scored: { mem: MemoryNode; score: number; units: string[] }[] = [];
    for (const d of docs) {
      if (!d.hits.size) continue;
      let num = 0;
      for (const u of d.hits) num += (qWeights.get(u) ?? 0) * idf(u);
      const score = denom > 0 ? num / denom : 0;
      if (score >= GroupKBEngine.FALLBACK_MIN) scored.push({ mem: d.mem, score, units: [...d.hits] });
    }
    return scored.sort((a, b) => b.score - a.score || a.mem.createdAt - b.mem.createdAt).slice(0, 5);
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
   * 5. Meaning-only queries: the query is "understood" first (function words dropped, concept words
   *    added at a lower weight — `retrieval-lexicon.ts`) and ROUTED to the groups whose vocabulary
   *    names the same concepts; when the best hit is still weak, a broader fragment pass runs and its
   *    hits come back in `fallback`, never in `nodes`.
   */
  query(
    queryText: string,
    options?: { budget?: number; includeRetired?: boolean; channels?: RetrievalChannel[] },
  ): KBQueryResultWithFallback {
    const startTime = performance.now();
    /*
     * Which channels get to score.
     *
     * Default: both, unchanged from before — the renormalisation below divides by the sum of the
     * active weights, which is 1 when neither is switched off, so the production ranking is
     * bit-for-bit what it was.
     *
     * The switch exists so the two channels can be MEASURED against each other (评测报告 5a:
     * "规模下的检索质量未验"). A fused score can look good while one channel is carrying the other;
     * the only way to know is to rank with each alone on a corpus big enough for ranking to matter.
     */
    const channels: RetrievalChannel[] = options?.channels ?? ['lexical', 'structural'];
    const chanSet = new Set(channels);
    /*
     * Entry points are shared, deliberately.
     *
     * Structural resonance needs a seed to start from, and seeds come from BM25 hits and explicit
     * anchors. Switching off the lexical CHANNEL must not switch off the lexical ENTRY, or
     * "structural only" would return nothing for any query that is not a literal anchor — that
     * would measure a broken switch, not a channel.
     */
    const structWeight = chanSet.has('structural') ? GroupKBEngine.W_STRUCTURAL : 0;
    const lexWeight = chanSet.has('lexical') ? GroupKBEngine.W_LEXICAL : 0;
    const weightSum = structWeight + lexWeight;

    // Retired memories are out of retrieval unless asked for (see `retireMemory`). They are
    // dropped as entry points and as results; nothing else about the scoring changes.
    const includeRetired = options?.includeRetired === true;
    const hidden = (mem: MemoryNode): boolean => !includeRetired && this.isRetired(mem);
    const budget = options?.budget ?? this.config.activationBudget;
    const psConfig = this.config.pulseSeed;

    // ── Channel A: lexical ranking over the UNDERSTOOD query ──
    // Function-word bigrams dropped, concept words added at a lower weight (retrieval-lexicon.ts).
    const understood = queryTerms(queryText, tokenizeQuery);
    const lexicalHits = this.store.bm25Search(queryText, {
      limit: Math.max(3, Math.min(80, budget)),
      terms: understood.terms,
    }).filter((h) => !hidden(h.mem));
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
    /** Groups the query names; `byPath` = the query writes the group's whole path as one word. */
    const anchoredGroups: { id: string; path: string; byPath: boolean }[] = [];
    {
      const q = queryText.trim().toLowerCase();
      const queryIds = idTokens(queryText);
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
          // Names are usually full paths already: joining every level doubled them.
          return collapseGroupNameChain(parts).join('/').toLowerCase();
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
          // An ID-like token (`plan_4dda269d`) is one name: its "plan" piece must not anchor `errors/plan_list`.
          const qTokens = q.split(/[\s,/]+/).flatMap((t) => (queryIds.has(t) ? [t] : t.split(/[-_.]+/))).filter((t) => t.length >= 3);
          const tokenHit = qTokens.some((t) => segments.has(t));
          /*
           * 查询里"提到"这个组，必须是**按词**提到，不是**包含子串**。
           *
           * 这里原来写的是 `q.includes(path)`，于是 `grp22` 里的 `grp22`.includes('grp2') 成立，
           * 组 `grp2` 也被当成锚点 —— 实测（`scripts/kb-retrieval-check.mjs`，250 个主题）里
           * 查询 `grp22` 的前四名全是主题 2 的内容，真正想要的组排到第 8 位。锚点带 ANCHOR_BONUS
           * 3.5，一次误判就足以把答案挤出视野，而 `grp2` / `grp1` 这种前缀冲突在真实命名里遍地都是
           * （`agent` / `agent-usability`、`ops` / `ops-kb`）。
           *
           * 判据因此改成"整体相等"或"按词命中"：`q === path` 覆盖整条路径，`qTokens` 覆盖它出现在
           * 句子里（`看看 grp22 的内容`）。`tokenHit` 保留原有的分词命中（`agent-usability` →
           * 查询 `agent` 仍能找到它），因为那是**词**级别的，不受子串问题影响。
           */
          const isAnchor = q === name || q === path
            || qTokens.includes(name) || qTokens.includes(path)
            || q.endsWith('/' + name) || path.endsWith('/' + q)
            || tokenHit;
          if (!isAnchor) continue;
          anchoredGroups.push({ id: g.id, path, byPath: q === path || q.split(/[\s,]+/).includes(path) });
        }
        /*
         * The most specific path wins. A query spelling out "project/x/env" also names "project"
         * (as a word), and anchoring both put the parent's notes level with the group actually named
         * — and a sibling sharing the "project" segment came along too. When the query writes a
         * nested group's full path, only that group (and its subgroups) anchor.
         */
        const written = anchoredGroups.filter((b) => b.byPath && b.path.includes('/')
          && !anchoredGroups.some((c) => c !== b && c.byPath && c.path.startsWith(b.path + '/')));
        for (const a of anchoredGroups) {
          const shadowed = written.length > 0
            && !written.some((b) => a.path === b.path || a.path.startsWith(b.path + '/'));
          if (shadowed) continue;
          for (const mem of this.store.getMemoriesByGroup(a.id)) groupAnchors.push(mem);
        }
      }
    }

    // ── Concept routing: groups the query is ABOUT, in other words than their name ──
    /*
     * Routing is for queries whose own words found nothing that fits. When a lexical hit already
     * covers most of what the user typed, the query was answered literally, and lifting a whole
     * group by an inferred concept would only push that answer down ("为什么更新计划时要把整份计划都
     * 返回" names the `plan` concept, but one note says exactly that). So routing strength scales
     * with how much of the query the best lexical hits leave UNcovered.
     */
    let literalCoverage = 0;
    for (const h of lexicalHits.slice(0, 3)) {
      literalCoverage = Math.max(literalCoverage, this.coverage(understood.own, h.mem));
    }
    const routeScale = Math.max(0, 1 - literalCoverage);
    const routes = routeScale > 0 ? this.routeGroups(understood.concepts) : new Map<string, { score: number; why: string }>();
    const routedNodes = new Map<string, { score: number; why: string; group: string }>();
    for (const [gid, r] of routes) {
      const g = this.store.getGroup(gid);
      const score = r.score * routeScale;
      for (const mem of this.store.getMemoriesByGroup(gid)) {
        const prev = routedNodes.get(mem.id);
        if (!prev || prev.score < score) routedNodes.set(mem.id, { score, why: r.why, group: g ? this.buildGroupPath(g) : gid });
      }
    }

    const anchorIds = new Set([...anchorNodes, ...groupAnchors].map((n) => n.id));
    /*
     * 锚点在自己组里的次序，用来决定同分锚点的先后。
     *
     * 需求不是"中心节点永远第一"，是**可复现**：同一份数据、同一条查询，每次该返回同样的顺序。
     * 实测中四个同组成员 `final` 只差 1e-12（时效项的噪声），`createdAt` 又常常是同一毫秒，
     * 于是顺序落到 `id` 上 —— UUID，随机但稳定。稳定够用，却不可解释。
     *
     * 组内次序是可解释的那一个："这个组里最早归档的那条排前面"。取第一次出现的锚定组，
     * 因为一条记忆可以同时属于多个组。
     */
    const anchorRank = new Map<string, number>();
    for (const g of this.store.getAllGroups()) {
      if (!groupAnchors.some((n) => n.groupIds.includes(g.id))) continue;
      g.memoryIds.forEach((memId, i) => {
        if (!anchorRank.has(memId)) anchorRank.set(memId, i);
      });
    }
    const seeds: MemoryNode[] = [];
    const seenSeed = new Set<string>();
    const routedMems = [...routedNodes.keys()]
      .map((id) => this.store.getMemory(id))
      .filter((m): m is MemoryNode => Boolean(m));
    for (const node of [...anchorNodes, ...groupAnchors, ...lexicalHits.map((h) => h.mem), ...routedMems]) {
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
      const lex = lexicalById.get(nodeId) ?? 0;
      const lexW = maxSeedLex > 0 ? lex / maxSeedLex : 0;
      // A routed node enters with at most half the energy of an exact hit: routing is inferred.
      const routeW = (routedNodes.get(nodeId)?.score ?? 0) * 0.5;
      return Math.max(SEED_ENERGY_FLOOR, Math.min(1, Math.max(lexW, routeW)));
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
      /*
       * Renormalised by the active weights, so switching a channel off does not just shrink every
       * score (which would make "lexical only" lose to "both" on every absolute threshold). With
       * both channels on, `weightSum` is 1 and this is the original expression exactly.
       */
      const base = weightSum > 0
        ? (structWeight * structPart + lexWeight * lexPart) / weightSum
        : 0;
      // An anchor with no fused signal at all is still worth surfacing (a group
      // name can legitimately share no tokens with its contents).
      if (base <= 0 && !anchorIds.has(nodeId)) continue;

      // Anchors rank first — see ANCHOR_BONUS for the measured effect. Routed groups come next.
      const route = routedNodes.get(nodeId);
      const anchorWeight = anchorIds.has(nodeId)
        ? GroupKBEngine.ANCHOR_BONUS
        : route ? 1 + GroupKBEngine.ROUTE_BONUS * route.score : 1;

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

    /*
     * 并列的判定要先量化，再谈次序。
     *
     * 两个**真正并列**的节点（同一次组名锚点命中的四个成员）`final` 会相差 1e-12 量级：那个差来自
     * `computeSignalBoost` 里的时效项 `0.85 + 0.15*exp(-ageDays/120)` —— 同一毫秒写入的节点也会算出
     * 不同 `ageDays`。让这个噪声决定排序，等于让"组名查询先返回哪一条"不可复现。
     *
     * 量化到 1e-6 之后噪声折进同一档，次序依次交给：写入时间（升序）→ 组内次序（见 `anchorRank`）
     * → id（UUID，只作为最后的兜底）。真实的分数差异远大于 1e-6，所以这一步不会改变任何"确实
     * 不一样"的排序。
     */
    const scoreBucket = (x: number): number => Math.round(x / GroupKBEngine.SCORE_EPSILON);
    const rankOf = (id: string): number => anchorRank.get(id) ?? Number.MAX_SAFE_INTEGER;
    scored.sort((a, b) =>
      scoreBucket(b.final) - scoreBucket(a.final)
      || a.mem.createdAt - b.mem.createdAt
      || rankOf(a.mem.id) - rankOf(b.mem.id)
      || (a.mem.id < b.mem.id ? -1 : a.mem.id > b.mem.id ? 1 : 0));

    // Absolute relevance floor (independent of the top hit, so a larger budget
    // can only ever ADD results — never remove them).
    const relevanceFloor = Math.max(0.05, psConfig.resonanceThreshold * 0.5);
    const MAX_RESULTS = 40;

    const nodes: MemoryNode[] = [];
    const traces: ActivationTrace[] = [];
    /** Expansion words (not typed by the user) that a node contains, as "query word→concept:word". */
    const expansionVia = (mem: MemoryNode): string[] => {
      const hay = `${mem.title}\n${mem.content}`.toLowerCase();
      const out: string[] = [];
      for (const t of understood.terms) {
        if (!t.via || out.length >= 3) continue;
        if (hay.includes(t.token)) out.push(`${t.via}:${t.token}`);
      }
      return out;
    };

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
      // Why an expanded or routed match matched — the concept word that carried it.
      const route = routedNodes.get(mem.id);
      if (route && !anchorIds.has(mem.id)) parts.push(`concept route ${route.why} → ${route.group}`);
      const via = expansionVia(mem);
      if (via.length) parts.push(`via ${via.join('、')}`);
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

    /*
     * ── Fallback: a second, broader pass when the primary one is weak ──
     *
     * Weak means: nothing found, or the best hit is neither an anchor nor in a routed group AND
     * covers less than a third of the query's own words (idf-weighted). Its hits are returned in
     * `fallback`, never mixed into `nodes`, so the confident list keeps meaning what it meant.
     */
    let fallback: KBFallbackResult | undefined;
    const top = scored.find((e) => e.final >= relevanceFloor);
    const topCoverage = top ? this.coverage(understood.own, top.mem) : 0;
    const weak = !top || (!anchorIds.has(top.mem.id) && !routedNodes.has(top.mem.id)
      && topCoverage < GroupKBEngine.WEAK_COVERAGE);
    if (weak) {
      const found = this.fallbackPass(queryText, understood.terms, new Set(nodes.slice(0, 5).map((n) => n.id)), hidden);
      if (found.length) {
        fallback = {
          nodes: found.map((f) => f.mem),
          traces: found.map((f) => {
            const memGroups = f.mem.groupIds
              .map((gid) => this.store.getGroup(gid))
              .filter((g): g is Group => g !== undefined);
            return {
              nodeId: f.mem.id,
              groupPath: memGroups.length ? memGroups.map((g) => this.buildGroupPath(g)) : ['(ungrouped)'],
              pulseSeeds: [],
              activationLevel: 0,
              reason: `fallback overlap ${f.score.toFixed(2)}: ${f.units.slice(0, 6).join(' ')}`,
              lexicalScore: 0,
              finalScore: f.score,
              signalBoost: 1,
              signalNotes: [],
            };
          }),
          reason: !top
            ? '主检索没有命中'
            : `主检索最佳结果只覆盖查询词的 ${Math.round(topCoverage * 100)}%`,
        };
      }
    }

    return {
      nodes,
      traces,
      groupsVisited: [...groupsVisited],
      totalNodesScanned: counter.n,
      queryTimeMs: performance.now() - startTime,
      pulseSeeds: allPulseSeeds,
      diagnostics: this.buildQueryDiagnostics({
        channels,
        lexicalCandidates: lexicalById.size,
        structuralCandidates: activationMap.size,
        fusedCandidates: scored.length,
        scores: scored.map((s) => s.final),
        aboveFloor: nodes.length,
        floor: relevanceFloor,
        limit: MAX_RESULTS,
      }),
      ...(fallback ? { fallback } : {}),
    };
  }

  /**
   * 把一次检索的规模与分数分布整理成读数。
   *
   * 分数分布的**中位数**是关键那一项：在一个小库里，答案排第一和排第十看起来一样；在大库里，
   * 一旦中位数贴着地板抬起来，"分数不低"就不再等于"找对了" —— 那时唯一能看出退化的是
   * `scores.max / scores.median` 这个比值，以及 `aboveFloor` 是不是已经贴到 `limit`。
   */
  private buildQueryDiagnostics(input: {
    channels: RetrievalChannel[];
    lexicalCandidates: number;
    structuralCandidates: number;
    fusedCandidates: number;
    scores: number[];
    aboveFloor: number;
    floor: number;
    limit: number;
  }): KBQueryDiagnostics {
    const sorted = [...input.scores].sort((a, b) => a - b);
    const median = sorted.length === 0
      ? 0
      : (sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
    return {
      channels: input.channels,
      candidates: {
        lexical: input.lexicalCandidates,
        structural: input.structuralCandidates,
        fused: input.fusedCandidates,
      },
      scores: {
        max: sorted.length ? sorted[sorted.length - 1] : 0,
        median,
        min: sorted.length ? sorted[0] : 0,
        aboveFloor: input.aboveFloor,
        floor: input.floor,
      },
      limit: input.limit,
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
    return collapseGroupNameChain(path).join(' \u2192 ');
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
