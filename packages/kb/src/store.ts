import Database from 'better-sqlite3';
import type { Group, MemoryNode, Edge, GroupStats, EdgeKind } from '@she/shared';
import { randomUUID } from 'node:crypto';

// ─── Row types for SQLite serialization ───

interface GroupRow {
  id: string;
  name: string;
  name_is_group_ref: number;
  parent_group_id: string | null;
  child_group_ids: string;
  memory_ids: string;
  weak_edge_ids: string;
  cross_group_edge_ids: string;
  competition_subgroup_ids: string;
  is_competition_subgroup: number;
  local_index: string;
  hormone_marker: number;
  trust_constant: number;
  is_dormant: number;
  stats: string;
  max_children_before_split: number;
  created_at: number;
  updated_at: number;
}

interface MemoryRow {
  id: string;
  kind: string;
  title: string;
  content: string;
  metadata: string;
  group_ids: string;
  access_count: number;
  last_accessed_at: number;
  created_at: number;
  updated_at: number;
  is_dormant: number;
}

interface EdgeRow {
  id: string;
  kind: string;
  source_id: string;
  target_id: string;
  weight: number;
  direction: string;
  evidence: string | null;
  falsifiers: string | null;
  created_at: number;
}

// ─── Conversion helpers ───

function rowToGroup(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    nameIsGroupRef: !!row.name_is_group_ref,
    parentGroupId: row.parent_group_id,
    childGroupIds: JSON.parse(row.child_group_ids),
    memoryIds: JSON.parse(row.memory_ids),
    weakEdgeIds: JSON.parse(row.weak_edge_ids),
    crossGroupEdgeIds: JSON.parse(row.cross_group_edge_ids),
    competitionSubgroupIds: JSON.parse(row.competition_subgroup_ids),
    isCompetitionSubgroup: !!row.is_competition_subgroup,
    localIndex: JSON.parse(row.local_index),
    hormoneMarker: row.hormone_marker,
    trustConstant: row.trust_constant,
    isDormant: !!row.is_dormant,
    stats: JSON.parse(row.stats),
    maxChildrenBeforeSplit: row.max_children_before_split,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToMemory(row: MemoryRow): MemoryNode {
  return {
    id: row.id,
    kind: row.kind as MemoryNode['kind'],
    title: row.title,
    content: row.content,
    metadata: JSON.parse(row.metadata),
    groupIds: JSON.parse(row.group_ids),
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isDormant: !!row.is_dormant,
  };
}

function rowToEdge(row: EdgeRow): Edge {
  return {
    id: row.id,
    kind: row.kind as EdgeKind,
    sourceId: row.source_id,
    targetId: row.target_id,
    weight: row.weight,
    direction: row.direction as Edge['direction'],
    evidence: row.evidence ?? undefined,
    falsifiers: row.falsifiers ? JSON.parse(row.falsifiers) : undefined,
    createdAt: row.created_at,
  };
}

function defaultStats(): GroupStats {
  return {
    totalMemories: 0,
    directMemories: 0,
    compressedMemories: 0,
    totalChildren: 0,
    accessCount: 0,
  };
}

// ─── Input types for creation ───

export interface CreateGroupInput {
  name: string;
  nameIsGroupRef?: boolean;
  parentGroupId?: string | null;
  maxChildrenBeforeSplit?: number;
}

export interface CreateMemoryInput {
  kind: MemoryNode['kind'];
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  groupIds?: string[];
}

export interface CreateEdgeInput {
  kind: EdgeKind;
  sourceId: string;
  targetId: string;
  weight?: number;
  direction?: Edge['direction'];
  evidence?: string;
  falsifiers?: string[];
}

// ─── KBStore class ───

export class KBStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_is_group_ref INTEGER NOT NULL DEFAULT 0,
        parent_group_id TEXT,
        child_group_ids TEXT NOT NULL DEFAULT '[]',
        memory_ids TEXT NOT NULL DEFAULT '[]',
        weak_edge_ids TEXT NOT NULL DEFAULT '[]',
        cross_group_edge_ids TEXT NOT NULL DEFAULT '[]',
        competition_subgroup_ids TEXT NOT NULL DEFAULT '[]',
        is_competition_subgroup INTEGER NOT NULL DEFAULT 0,
        local_index TEXT NOT NULL DEFAULT '{}',
        hormone_marker REAL NOT NULL DEFAULT 1.0,
        trust_constant REAL NOT NULL DEFAULT 1.0,
        is_dormant INTEGER NOT NULL DEFAULT 0,
        stats TEXT NOT NULL DEFAULT '${JSON.stringify(defaultStats())}',
        max_children_before_split INTEGER NOT NULL DEFAULT 12,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        group_ids TEXT NOT NULL DEFAULT '[]',
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_dormant INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        direction TEXT NOT NULL DEFAULT 'bidirectional',
        evidence TEXT,
        falsifiers TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_groups_parent ON groups(parent_group_id);
      CREATE INDEX IF NOT EXISTS idx_memories_dormant ON memories(is_dormant);
    `);
  }

  // ─── Group CRUD ───

  getGroup(id: string): Group | undefined {
    const row = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined;
    return row ? rowToGroup(row) : undefined;
  }

  getAllGroups(): Group[] {
    const rows = this.db.prepare('SELECT * FROM groups').all() as GroupRow[];
    return rows.map(rowToGroup);
  }

  getRootGroups(): Group[] {
    const rows = this.db.prepare('SELECT * FROM groups WHERE parent_group_id IS NULL').all() as GroupRow[];
    return rows.map(rowToGroup);
  }

  getMemoriesByGroup(groupId: string): MemoryNode[] {
    const group = this.getGroup(groupId);
    if (!group) return [];
    return group.memoryIds.map(id => this.getMemory(id)).filter((m): m is MemoryNode => m !== undefined);
  }

  getEdgesBetween(a: string, b: string): Edge[] {
    const rows = this.db.prepare(
      'SELECT * FROM edges WHERE (source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?)'
    ).all(a, b, b, a) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  getStats(): { totalGroups: number; totalMemories: number; totalEdges: number } {
    const groups = (this.db.prepare('SELECT COUNT(*) as c FROM groups').get() as { c: number }).c;
    const memories = (this.db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    const edges = (this.db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;
    return { totalGroups: groups, totalMemories: memories, totalEdges: edges };
  }

  createGroup(input: CreateGroupInput): Group {
    const now = Date.now();
    const id = randomUUID();
    const stats = defaultStats();

    this.db.prepare(`
      INSERT INTO groups (id, name, name_is_group_ref, parent_group_id, child_group_ids,
        memory_ids, weak_edge_ids, cross_group_edge_ids, competition_subgroup_ids,
        is_competition_subgroup, local_index, hormone_marker, trust_constant,
        is_dormant, stats, max_children_before_split, created_at, updated_at)
      VALUES (?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 0, '{}', 1.0, 1.0, 0, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.nameIsGroupRef ? 1 : 0,
      input.parentGroupId ?? null,
      JSON.stringify(stats),
      input.maxChildrenBeforeSplit ?? 12,
      now,
      now,
    );

    return this.getGroup(id)!;
  }

  updateGroup(id: string, partial: Partial<Group>): Group {
    const existing = this.getGroup(id);
    if (!existing) throw new Error(`Group not found: ${id}`);

    const now = Date.now();
    const merged = { ...existing, ...partial, updatedAt: now };

    this.db.prepare(`
      UPDATE groups SET
        name = ?, name_is_group_ref = ?, parent_group_id = ?,
        child_group_ids = ?, memory_ids = ?, weak_edge_ids = ?,
        cross_group_edge_ids = ?, competition_subgroup_ids = ?,
        is_competition_subgroup = ?, local_index = ?,
        hormone_marker = ?, trust_constant = ?, is_dormant = ?,
        stats = ?, max_children_before_split = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.name,
      merged.nameIsGroupRef ? 1 : 0,
      merged.parentGroupId,
      JSON.stringify(merged.childGroupIds),
      JSON.stringify(merged.memoryIds),
      JSON.stringify(merged.weakEdgeIds),
      JSON.stringify(merged.crossGroupEdgeIds),
      JSON.stringify(merged.competitionSubgroupIds),
      merged.isCompetitionSubgroup ? 1 : 0,
      JSON.stringify(merged.localIndex),
      merged.hormoneMarker,
      merged.trustConstant,
      merged.isDormant ? 1 : 0,
      JSON.stringify(merged.stats),
      merged.maxChildrenBeforeSplit,
      merged.updatedAt,
      id,
    );

    return this.getGroup(id)!;
  }

  deleteGroup(id: string): void {
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  }

  // ─── Memory CRUD ───

  getMemory(id: string): MemoryNode | undefined {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  /**
   * Structural seed lookup: find memories whose title or group name
   * contains query tokens. This is NOT keyword retrieval — it locates
   * structural entry points for PulseSeed propagation.
   * No FTS, no embeddings, no cosine similarity.
   */
  findSeedNodes(query: string): MemoryNode[] {
    const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
    if (tokens.length === 0) return [];

    const allMems = this.db.prepare('SELECT * FROM memories').all() as MemoryRow[];
    const scored: { mem: MemoryNode; score: number }[] = [];

    for (const row of allMems) {
      const mem = rowToMemory(row);
      const titleLower = mem.title.toLowerCase();
      const contentLower = mem.content.toLowerCase().slice(0, 500);

      let score = 0;
      for (const tok of tokens) {
        if (titleLower.includes(tok)) score += 3;
        if (contentLower.includes(tok)) score += 1;
      }

      const groupNames = mem.groupIds
        .map(gid => this.getGroup(gid))
        .filter(Boolean)
        .map(g => g!.name.toLowerCase());
      for (const tok of tokens) {
        for (const gn of groupNames) {
          if (gn.includes(tok)) score += 2;
        }
      }

      if (score > 0) scored.push({ mem, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.mem);
  }

  createMemory(input: CreateMemoryInput): MemoryNode {
    const now = Date.now();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO memories (id, kind, title, content, metadata, group_ids,
        access_count, last_accessed_at, created_at, updated_at, is_dormant)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0)
    `).run(
      id,
      input.kind,
      input.title,
      input.content,
      JSON.stringify(input.metadata ?? {}),
      JSON.stringify(input.groupIds ?? []),
      now,
      now,
      now,
    );

    return this.getMemory(id)!;
  }

  updateMemory(id: string, partial: Partial<MemoryNode>): MemoryNode {
    const existing = this.getMemory(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);

    const now = Date.now();
    const merged = { ...existing, ...partial, updatedAt: now };

    this.db.prepare(`
      UPDATE memories SET
        kind = ?, title = ?, content = ?, metadata = ?, group_ids = ?,
        access_count = ?, last_accessed_at = ?, updated_at = ?, is_dormant = ?
      WHERE id = ?
    `).run(
      merged.kind,
      merged.title,
      merged.content,
      JSON.stringify(merged.metadata),
      JSON.stringify(merged.groupIds),
      merged.accessCount,
      merged.lastAccessedAt,
      merged.updatedAt,
      merged.isDormant ? 1 : 0,
      id,
    );

    return this.getMemory(id)!;
  }

  deleteMemory(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  // ─── Edge CRUD ───

  getEdge(id: string): Edge | undefined {
    const row = this.db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as EdgeRow | undefined;
    return row ? rowToEdge(row) : undefined;
  }

  getEdgesForNode(nodeId: string): Edge[] {
    const rows = this.db.prepare(
      'SELECT * FROM edges WHERE source_id = ? OR target_id = ?'
    ).all(nodeId, nodeId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  createEdge(input: CreateEdgeInput): Edge {
    const now = Date.now();
    const id = randomUUID();

    this.db.prepare(`
      INSERT INTO edges (id, kind, source_id, target_id, weight, direction, evidence, falsifiers, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.kind,
      input.sourceId,
      input.targetId,
      input.weight ?? 1.0,
      input.direction ?? 'bidirectional',
      input.evidence ?? null,
      input.falsifiers ? JSON.stringify(input.falsifiers) : null,
      now,
    );

    return this.getEdge(id)!;
  }

  deleteEdge(id: string): void {
    this.db.prepare('DELETE FROM edges WHERE id = ?').run(id);
  }

  // ─── Access tracking ───

  boostAccess(memoryId: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?
    `).run(now, memoryId);
  }

  getDormantMemories(thresholdDays: number): MemoryNode[] {
    const cutoff = Date.now() - thresholdDays * 24 * 60 * 60 * 1000;
    const rows = this.db.prepare(
      'SELECT * FROM memories WHERE last_accessed_at < ? AND is_dormant = 0'
    ).all(cutoff) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  // ─── Transaction helper ───

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
