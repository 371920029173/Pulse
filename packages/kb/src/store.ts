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

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/**
 * Tokenize a query for entry-point lookup.
 *
 * Latin words are kept whole (length > 1 to avoid noise). CJK runs are split
 * into character bigrams because they are not space-delimited, so an exact
 * whole-run match would almost never hit.
 */
function tokenizeQuery(query: string): string[] {
  const lowered = query.toLowerCase();
  const out = new Set<string>();

  for (const part of lowered.split(/[^\p{L}\p{N}_.\-/]+/u)) {
    if (!part) continue;
    const cjkRuns = part.match(CJK_RE);
    if (cjkRuns?.length) {
      for (const run of cjkRuns) {
        if (run.length >= 2) {
          out.add(run);
          for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
        }
      }
      const rest = part.replace(CJK_RE, ' ').trim();
      if (rest.length > 1) out.add(rest);
    } else if (part.length > 1) {
      out.add(part);
    }
  }
  return [...out];
}

// ─── Lexical (BM25) index ───
//
// The structural channel handles *where* knowledge lives and how it relates.
// It is weak at "which exact document is about this term" — that is what
// traditional IR is good at. This index supplies the classic BM25 ranking so
// the two channels can be fused (hybrid retrieval) instead of relying on
// substring matching.

interface LexicalIndex {
  /** token -> (memoryId -> weighted term frequency) */
  postings: Map<string, Map<string, number>>;
  docLen: Map<string, number>;
  avgDocLen: number;
  docCount: number;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Title terms count for more than body terms (field weighting). */
const BM25_TITLE_WEIGHT = 2.5;

export interface LexicalHit {
  mem: MemoryNode;
  score: number;
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
  /** Lazily built BM25 index; invalidated on any memory mutation. */
  private lexical: LexicalIndex | null = null;
  /**
   * Group object cache.
   *
   * Query paths previously called getGroup() once per memory per token, which
   * is an N+1 against SQLite and dominated retrieval time on larger KBs. Groups
   * change rarely compared to how often they are read, so cache them and
   * invalidate on every group write.
   */
  private groupCache = new Map<string, Group>();
  /**
   * Memory object cache.
   *
   * Instrumentation showed a single query issued ~6400 single-row SELECTs via
   * getMemory() (group-sibling scans during propagation), which was ~58% of
   * total query time. Memories change far less often than they are read, so
   * cache them and invalidate on write. Bounded to keep RAM sane on huge KBs.
   */
  private memCache = new Map<string, MemoryNode>();
  private static readonly MEM_CACHE_MAX = 20000;
  /** Memoized prepared statements (prepare() re-parses on every call). */
  private stmtCache = new Map<string, Database.Statement>();

  private cacheMemory(mem: MemoryNode): MemoryNode {
    if (this.memCache.size >= KBStore.MEM_CACHE_MAX) this.memCache.clear();
    this.memCache.set(mem.id, mem);
    return mem;
  }

  private invalidateMemories(): void {
    this.memCache.clear();
  }

  private invalidateMemory(id: string): void {
    this.memCache.delete(id);
  }

  private stmt(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  private invalidateGroups(): void {
    this.groupCache.clear();
  }

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    // DELETE, not WAL: the bytes live in kb.sqlite itself. WAL leaves the real
    // rows in a sidecar, so a copy or a look at the main file sees an empty base.
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
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
    const cached = this.groupCache.get(id);
    if (cached) return cached;
    const row = this.stmt('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined;
    if (!row) return undefined;
    const group = rowToGroup(row);
    this.groupCache.set(id, group);
    return group;
  }

  getAllGroups(): Group[] {
    const rows = this.stmt('SELECT * FROM groups').all() as GroupRow[];
    const groups = rows.map(rowToGroup);
    // Warm the cache — callers almost always follow up with getGroup().
    for (const g of groups) this.groupCache.set(g.id, g);
    return groups;
  }

  getRootGroups(): Group[] {
    const rows = this.stmt('SELECT * FROM groups WHERE parent_group_id IS NULL').all() as GroupRow[];
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

    this.invalidateGroups();
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

    // Drop the cached copy before writing so the read-back at the end is fresh.
    this.invalidateGroups();
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
    this.invalidateGroups();
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  }

  // ─── Memory CRUD ───

  getMemory(id: string): MemoryNode | undefined {
    const cached = this.memCache.get(id);
    if (cached) return cached;
    const row = this.stmt('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
    return row ? this.cacheMemory(rowToMemory(row)) : undefined;
  }

  /**
   * Score memories against explicit anchors and/or query tokens.
   * Anchors are exact (@group / #title / id); tokens are fuzzy containment.
   */
  private scoreMemories(
    query: string,
    opts: { useAnchors: boolean; useTokens: boolean },
  ): { mem: MemoryNode; score: number }[] {
    const raw = query.trim();
    if (!raw) return [];

    const anchors = opts.useAnchors
      ? raw.match(/@group:[^\s]+|@[^\s]+|#[^\s]+|\b(?:node|grp|group|mem|seed)_[a-zA-Z0-9-]+\b/g) ?? []
      : [];
    const tokens = opts.useTokens ? tokenizeQuery(raw) : [];
    if (!anchors.length && !tokens.length) return [];

    const allMems = this.stmt('SELECT * FROM memories').all() as MemoryRow[];
    const scored: { mem: MemoryNode; score: number }[] = [];

    for (const row of allMems) {
      const mem = rowToMemory(row);
      const titleLower = mem.title.toLowerCase();
      const titleStem = titleLower.replace(/\.[^.]+$/, '');
      const contentLower = mem.content.toLowerCase();
      const groupNames = mem.groupIds
        .map((gid) => this.getGroup(gid))
        .filter((g): g is NonNullable<typeof g> => Boolean(g))
        .map((g) => g.name.toLowerCase());
      let score = 0;

      // Explicit anchors are the strongest signal.
      for (const a of anchors) {
        if (a.startsWith('#')) {
          const t = a.slice(1).toLowerCase();
          if (titleLower === t || titleStem === t) score += 8;
        } else if (a.startsWith('@')) {
          const name = a.replace(/^@group:/, '').replace(/^@/, '').toLowerCase();
          if (groupNames.includes(name)) score += 8;
        } else if (a === mem.id) {
          score += 8;
        }
      }

      // Token containment. Titles/group names rank above body text so the
      // propagation starts from the most structurally relevant entry points.
      for (const tok of tokens) {
        if (titleLower === tok) score += 5;
        else if (titleStem === tok) score += 4;
        else if (titleLower.includes(tok)) score += 3;

        if (groupNames.some((n) => n === tok)) score += 3;
        else if (groupNames.some((n) => n.includes(tok))) score += 2;

        if (contentLower.includes(tok)) score += 1;
      }

      if (score > 0) scored.push({ mem, score });
    }

    scored.sort((a, b) => b.score - a.score || a.mem.createdAt - b.mem.createdAt);
    return scored;
  }

  /**
   * Bootstrap lookup: locate ENTRY POINTS into the group structure for a query.
   *
   * Mixes explicit anchors with fuzzy token containment. `findExplicitAnchors`
   * is the stricter variant used by hybrid retrieval, where fuzzy matches must
   * NOT be treated as high-confidence anchors.
   *
   * Hard rules preserved: no embeddings, no cosine similarity, no FTS index,
   * no automatic promotion of edge kinds.
   */
  findSeedNodes(query: string): MemoryNode[] {
    return this.scoreMemories(query, { useAnchors: true, useTokens: true }).map((s) => s.mem);
  }

  /** Only true anchors: `@group:name`, `@name`, `#title`, or an explicit node id. */
  findExplicitAnchors(query: string): MemoryNode[] {
    return this.scoreMemories(query, { useAnchors: true, useTokens: false }).map((s) => s.mem);
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
    this.lexical = null;
    this.invalidateMemory(id);
    this.invalidateMemories();

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
    this.lexical = null;
    this.invalidateMemories();

    return this.getMemory(id)!;
  }

  deleteMemory(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    this.lexical = null;
    this.invalidateMemory(id);
  }

  // ─── Lexical (BM25) retrieval ───

  private getLexicalIndex(): LexicalIndex {
    if (this.lexical) return this.lexical;
    const postings = new Map<string, Map<string, number>>();
    const docLen = new Map<string, number>();

    const rows = this.stmt('SELECT id, title, content FROM memories').all() as {
      id: string;
      title: string;
      content: string;
    }[];

    let totalLen = 0;
    for (const row of rows) {
      const tf = new Map<string, number>();
      for (const t of tokenizeQuery(row.title ?? '')) {
        tf.set(t, (tf.get(t) ?? 0) + BM25_TITLE_WEIGHT);
      }
      for (const t of tokenizeQuery(row.content ?? '')) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
      let len = 0;
      for (const v of tf.values()) len += v;
      const safeLen = len || 1;
      docLen.set(row.id, safeLen);
      totalLen += safeLen;

      for (const [token, freq] of tf) {
        let posting = postings.get(token);
        if (!posting) {
          posting = new Map<string, number>();
          postings.set(token, posting);
        }
        posting.set(row.id, freq);
      }
    }

    const docCount = rows.length;
    this.lexical = {
      postings,
      docLen,
      avgDocLen: docCount ? totalLen / docCount : 1,
      docCount,
    };
    return this.lexical;
  }

  /**
   * Classic BM25 ranking over memory title + content.
   *
   * This is the "traditional RAG" half of hybrid retrieval: real IDF weighting
   * instead of substring containment, so a rare exact term is not drowned out
   * by common words. It returns ranked ENTRY POINTS; the structural pulse still
   * decides what else gets pulled in via the group graph.
   */
  bm25Search(query: string, opts?: { limit?: number }): LexicalHit[] {
    const limit = Math.max(1, opts?.limit ?? 20);
    const tokens = [...new Set(tokenizeQuery(query))];
    if (!tokens.length) return [];

    const idx = this.getLexicalIndex();
    if (!idx.docCount) return [];

    const scores = new Map<string, number>();
    for (const token of tokens) {
      const posting = idx.postings.get(token);
      if (!posting) continue;
      const df = posting.size;
      // BM25 idf with the +1 guard so a term in every doc still contributes a little.
      const idf = Math.log(1 + (idx.docCount - df + 0.5) / (df + 0.5));
      for (const [memId, tf] of posting) {
        const dl = idx.docLen.get(memId) ?? 1;
        const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / idx.avgDocLen));
        const termScore = idf * ((tf * (BM25_K1 + 1)) / (denom || 1));
        scores.set(memId, (scores.get(memId) ?? 0) + termScore);
      }
    }

    const hits: LexicalHit[] = [];

    // Rank FIRST, then batch-load only the winners.
    // The previous version called getMemory() once per scoring hit, which is an
    // N+1 — a query matching every row issued one SELECT per row and accounted
    // for essentially 100% of query time.
    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);
    if (!ranked.length) return [];

    const ids = ranked.map(([id]) => id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.stmt(`SELECT * FROM memories WHERE id IN (${placeholders})`).all(...ids) as MemoryRow[];
    const byId = new Map<string, MemoryNode>();
    for (const row of rows) {
      const mem = this.cacheMemory(rowToMemory(row));
      byId.set(mem.id, mem);
    }

    for (const [id, score] of ranked) {
      const mem = byId.get(id);
      if (mem) hits.push({ mem, score });
    }
    hits.sort((a, b) => b.score - a.score || a.mem.createdAt - b.mem.createdAt);
    return hits;
  }

  // ─── Edge CRUD ───

  getEdge(id: string): Edge | undefined {
    const row = this.stmt('SELECT * FROM edges WHERE id = ?').get(id) as EdgeRow | undefined;
    return row ? rowToEdge(row) : undefined;
  }

  getEdgesForNode(nodeId: string): Edge[] {
    const rows = this.stmt(
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
    this.stmt(`
      UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?
    `).run(now, memoryId);
    // access_count changed, so the cached copy is stale.
    this.invalidateMemory(memoryId);
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
