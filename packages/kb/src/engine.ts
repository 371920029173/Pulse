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
      if (current === childId) continue;
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

        const subName = `${group.name}/part-${i + 1}`;
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
        .map(m => `[${m.title}]: ${m.content.slice(0, 200)}`)
        .join('\n---\n');

      const summary = this.store.createMemory({
        kind: 'text',
        title: `[compressed] ${titles.slice(0, 100)}`,
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

  /**
   * Query the KB via PulseSeed structural resonance propagation.
   *
   * 1. Bootstrap: structural seed lookup finds ENTRY POINTS (no FTS/embedding)
   * 2. Each entry point spawns a PulseSeed
   * 3. PulseSeeds propagate through group structure via edges with energy decay
   * 4. Nodes that structurally resonate (shared groups, edges, hierarchy) activate
   * 5. Results sorted by total received energy with full activation traces
   */
  query(
    queryText: string,
    options?: { budget?: number },
  ): KBQueryResult {
    const startTime = performance.now();
    const budget = options?.budget ?? this.config.activationBudget;
    const psConfig = this.config.pulseSeed;

    const seedNodes = this.store.findSeedNodes(queryText);

    const allPulseSeeds: PulseSeed[] = [];
    const activationMap = new Map<string, number>();
    const nodeSeeds = new Map<string, PulseSeed[]>();
    const groupsVisited = new Set<string>();
    let totalNodesScanned = 0;

    for (const seedNode of seedNodes) {
      if (totalNodesScanned >= budget) break;
      totalNodesScanned++;

      const sourceGroupId = seedNode.groupIds[0] ?? '__root__';

      const pulse: PulseSeed = {
        id: `ps-${seedNode.id.slice(0, 8)}`,
        sourceNodeId: seedNode.id,
        sourceGroupId,
        energy: psConfig.initialEnergy,
        origin: queryText,
        hop: 0,
        path: [],
        resonatedAt: Date.now(),
      };

      allPulseSeeds.push(pulse);
      activationMap.set(seedNode.id, psConfig.initialEnergy);
      nodeSeeds.set(seedNode.id, [pulse]);

      for (const gid of seedNode.groupIds) {
        groupsVisited.add(gid);
      }

      this.propagatePulse(
        pulse, seedNode.id, psConfig.initialEnergy, 0,
        activationMap, nodeSeeds, groupsVisited,
        totalNodesScanned, budget, psConfig,
        new Set<string>([seedNode.id]),
      );
      totalNodesScanned = Math.max(totalNodesScanned, activationMap.size);
    }

    const sorted = [...activationMap.entries()]
      .filter(([, energy]) => energy >= psConfig.resonanceThreshold)
      .sort((a, b) => b[1] - a[1]);

    const nodes: MemoryNode[] = [];
    const traces: ActivationTrace[] = [];

    for (const [nodeId, activation] of sorted) {
      const mem = this.store.getMemory(nodeId);
      if (!mem) continue;

      this.store.boostAccess(nodeId);
      nodes.push(mem);

      const memGroups = mem.groupIds
        .map(gid => this.store.getGroup(gid))
        .filter((g): g is Group => g !== undefined);

      const seeds = nodeSeeds.get(nodeId) ?? [];
      traces.push({
        nodeId,
        groupPath: memGroups.map(g => this.buildGroupPath(g)),
        pulseSeeds: seeds,
        activationLevel: activation,
        reason: seeds.length > 0
          ? `Resonated via ${seeds.length} PulseSeed(s): ${seeds.map(s => s.path.length + ' hops').join(', ')}`
          : 'Direct seed match',
      });
    }

    return {
      nodes,
      traces,
      groupsVisited: [...groupsVisited],
      totalNodesScanned,
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
    scanned: number,
    budget: number,
    psConfig: SheConfig['kb']['pulseSeed'],
    visited: Set<string>,
  ): void {
    if (energy < psConfig.resonanceThreshold) return;
    if (hop >= psConfig.maxHops) return;
    if (scanned >= budget) return;

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
          activationMap.size, budget, psConfig, visited,
        );
      }
    }
  }

  private buildGroupPath(group: Group): string {
    const path: string[] = [group.name];
    let current = group;
    while (current.parentGroupId) {
      const parent = this.store.getGroup(current.parentGroupId);
      if (!parent) break;
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

    return this.addMemory(groupId, kind, title, content, {
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
