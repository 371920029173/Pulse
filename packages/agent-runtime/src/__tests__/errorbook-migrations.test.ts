/**
 * Startup sweep that retires error-book entries written by a since-fixed `reflection_check`.
 *
 * Uses the same in-memory KB fake as `errorbook.test.ts` (copied, since test files do not export),
 * and writes entries through the real `ErrorBook.recordReflection` so the stored shape is exactly
 * what production writes.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorBook } from '../errorbook.js';
import type { ErrorbookEngineLike, ErrorbookStoreLike } from '../errorbook.js';
import { detectDrift } from '../reflection.js';
import {
  retireKnownFalsePositives,
  parseReflectionEvidence,
  isAllowListConstraintFalsePositive,
  migrationsMarkerPath,
} from '../errorbook-migrations.js';

function fakeEngine() {
  interface G { id: string; name: string; parentGroupId: string | null }
  interface M {
    id: string;
    kind: string;
    title: string;
    content: string;
    metadata: Record<string, unknown>;
    accessCount: number;
  }
  const groups: G[] = [];
  const memories: M[] = [];
  const edges: { source: string; target: string; kind: string }[] = [];
  const groupOf = new Map<string, string[]>(); // group id -> memory ids
  let seq = 0;
  /** Nodes the fake can return from `query`, so lookup filtering can be driven. */
  let queryNodes: { id: string; title: string; content: string; kind: string; path: string }[] = [];
  let failEdges = false;

  const engine: ErrorbookEngineLike & ErrorbookStoreLike & {
    groups: G[];
    memories: M[];
    edges: typeof edges;
    setQueryNodes: (n: typeof queryNodes) => void;
    setFailEdges: (v: boolean) => void;
  } = {
    groups,
    memories,
    edges,
    setQueryNodes: (n) => { queryNodes = n; },
    setFailEdges: (v) => { failEdges = v; },

    createGroup(name, parentId) {
      const g = { id: `g${++seq}`, name, parentGroupId: parentId ?? null };
      groups.push(g);
      groupOf.set(g.id, []);
      return { id: g.id, name: g.name };
    },
    addMemoryMaintained(groupId, kind, title, content, metadata) {
      const m: M = { id: `m${++seq}`, kind, title, content, metadata: metadata ?? {}, accessCount: 0 };
      memories.push(m);
      groupOf.get(groupId)!.push(m.id);
      return { id: m.id };
    },
    addTypedEdge(sourceId, targetId, kind) {
      if (failEdges) throw new Error('edge store down');
      edges.push({ source: sourceId, target: targetId, kind });
      return {};
    },
    query() {
      return {
        nodes: queryNodes.map((n) => ({ id: n.id, title: n.title, content: n.content, kind: n.kind })),
        traces: queryNodes.map((n) => ({ groupPath: n.path.split(',') })),
      };
    },
    getAllGroups: () => groups.map((g) => ({ ...g })),
    getMemoriesByGroup(groupId) {
      return (groupOf.get(groupId) ?? [])
        .map((id) => memories.find((m) => m.id === id))
        .filter((m): m is M => Boolean(m))
        .map((m) => ({ id: m.id, title: m.title, content: m.content, metadata: m.metadata }));
    },
    updateMemory(id, partial) {
      const m = memories.find((x) => x.id === id);
      if (!m) throw new Error('no such memory');
      Object.assign(m, partial);
      return m;
    },
    boostAccess(id) {
      const m = memories.find((x) => x.id === id);
      if (m) m.accessCount++;
    },
  };
  return engine;
}


const KB_CONSTRAINT = '不得直读 .she/kb.sqlite，只用 kb_* 工具';
/** The old verdict: the allow-listed tools reported as the excluded object. */
const WHITELIST_FP = `约束「${KB_CONSTRAINT}」排除的对象「kb_*」出现在了 kb_upsert 的调用参数里`;
const DRIFT_FP = '最近 5 个动作没有提到目标里的任何词（目标词如：pid、15884、17856）；当前步骤「核对 LSP 与 KB 状态」没有提到目标里的任何词';

/** A real violation, as the CURRENT checker words it. */
function genuineViolation(): string {
  const r = detectDrift({
    goal: '整理知识库条目',
    constraints: [KB_CONSTRAINT],
    actions: [{ tool: 'shell', args: JSON.stringify({ command: 'sqlite3 .she/kb.sqlite "select count(*) from memories"' }) }],
  });
  const v = r.signals.find((s) => s.kind === 'constraint_violated');
  assert.ok(v, 'the fixed checker still reports reading the KB file with shell');
  return v!.detail;
}

const lesson = '示例教训';
let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'eb-mig-')); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

function seed() {
  const kb = fakeEngine();
  const book = new ErrorBook(kb, kb);
  const drift = book.recordReflection({ topic: '目标漂移', lesson, evidence: DRIFT_FP }).entry;
  const whitelist = book.recordReflection({ topic: '越过约束', lesson, evidence: WHITELIST_FP }).entry;
  const tool = book.record({ tool: 'shell', kind: 'nonzero_exit', call: 'cmd /c exit 3', detail: 'exit code: 3' }).entry;
  const over = book.recordReflection({ topic: '过度自信', lesson, evidence: '样本 5，自评均值 0.90，实际成功率 0.40，偏差 0.50' }).entry;
  const repeat = book.recordReflection({
    topic: '重复失败:shell', lesson, evidence: '本轮 shell 失败 2 次（nonzero_exit）：exit code: 1 | exit code: 2',
  }).entry;
  return { kb, book, drift, whitelist, tool, over, repeat };
}

const forgotten = (kb: ReturnType<typeof fakeEngine>, id: string) =>
  kb.memories.find((m) => m.id === id)?.metadata.errorForgotten === true;

describe('errorbook 迁移：退役已修复的 reflection 误报', () => {
  it('漂移误报和白名单约束误报被退役（可恢复、带原因），其它条目不动', () => {
    const { kb, book, drift, whitelist, tool, over, repeat } = seed();
    const res = retireKnownFalsePositives(kb, kb, { workspaceRoot: ws, kbPath: join(ws, '.she', 'kb.sqlite') });
    assert.equal(res.status, 'ran');
    assert.deepEqual(res.retired.map((r) => r.id).sort(), [drift.id, whitelist.id].sort());
    assert.ok(forgotten(kb, drift.id) && forgotten(kb, whitelist.id));
    for (const id of [tool.id, over.id, repeat.id]) assert.equal(forgotten(kb, id), false);
    // Retired, not deleted: still in the store, with the reason, and out of every read.
    const m = kb.memories.find((x) => x.id === whitelist.id)!;
    assert.equal(m.metadata.errorForgottenReason, 'known false positive fixed in v0.3.1: reflection-allowlist-constraint');
    assert.match(String(kb.memories.find((x) => x.id === drift.id)!.metadata.errorForgottenReason), /reflection-lexical-drift$/);
    assert.equal(book.count(), 3);
    assert.ok(existsSync(migrationsMarkerPath(ws)));
  });

  it('真正的越界（shell 直读 .she/kb.sqlite）不退役', () => {
    const kb = fakeEngine();
    const book = new ErrorBook(kb, kb);
    const real = book.recordReflection({ topic: '越过约束', lesson, evidence: genuineViolation() }).entry;
    // Mixed evidence — one false positive and one real violation — keeps the entry too.
    const mixedDrift = book.recordReflection({ topic: '目标漂移', lesson, evidence: `${genuineViolation()}；${DRIFT_FP}` }).entry;
    const res = retireKnownFalsePositives(kb, kb, { workspaceRoot: ws, kbPath: 'kb.sqlite' });
    assert.equal(res.status, 'ran');
    assert.deepEqual(res.retired, []);
    assert.equal(forgotten(kb, real.id), false);
    assert.equal(forgotten(kb, mixedDrift.id), false);
  });

  it('带预算超支的漂移、解析不了的证据不退役', () => {
    const kb = fakeEngine();
    const book = new ErrorBook(kb, kb);
    const budget = book.recordReflection({ topic: '目标漂移', lesson, evidence: `${DRIFT_FP}；已用 40 次工具调用，超过预算的 30 次` }).entry;
    const odd = book.recordReflection({ topic: '越过约束', lesson, evidence: '用户手写的一条说明' }).entry;
    retireKnownFalsePositives(kb, kb, { workspaceRoot: ws, kbPath: 'kb.sqlite' });
    assert.equal(forgotten(kb, budget.id), false);
    assert.equal(forgotten(kb, odd.id), false);
  });

  it('第二次运行是空操作（有标记就跳过；删了标记也找不到新的可退役条目）', () => {
    const { kb } = seed();
    const opts = { workspaceRoot: ws, kbPath: join(ws, '.she', 'kb.sqlite') };
    assert.equal(retireKnownFalsePositives(kb, kb, opts).retired.length, 2);
    const snapshot = JSON.stringify(kb.memories);
    const second = retireKnownFalsePositives(kb, kb, opts);
    assert.equal(second.status, 'skipped');
    assert.equal(JSON.stringify(kb.memories), snapshot);
    rmSync(migrationsMarkerPath(ws));
    const third = retireKnownFalsePositives(kb, kb, opts);
    assert.equal(third.status, 'ran');
    assert.deepEqual(third.retired, []);
    assert.equal(JSON.stringify(kb.memories), snapshot);
    const marker = JSON.parse(readFileSync(migrationsMarkerPath(ws), 'utf8'));
    assert.equal(Object.values(marker.errorbook_known_false_positives as Record<string, { registryVersion: number }>)[0].registryVersion, 1);
  });

  it('出错不抛：日志里记一条，启动继续', () => {
    const broken = { getAllGroups: () => { throw new Error('db locked'); } } as unknown as ErrorbookEngineLike & ErrorbookStoreLike;
    const warns: string[] = [];
    const res = retireKnownFalsePositives(broken, broken, {
      workspaceRoot: ws, kbPath: 'kb.sqlite', log: { info: () => {}, warn: (m) => warns.push(m) },
    });
    assert.equal(res.status, 'failed');
    assert.match(warns.join('\n'), /db locked/);
  });

  it('判定细节：用新解析器复核约束原文', () => {
    assert.equal(isAllowListConstraintFalsePositive(KB_CONSTRAINT, 'kb_*'), true);
    assert.equal(isAllowListConstraintFalsePositive(KB_CONSTRAINT, 'kb_'), true);
    assert.equal(isAllowListConstraintFalsePositive(KB_CONSTRAINT, 'she/kb.sqlite'), false);
    assert.equal(isAllowListConstraintFalsePositive(KB_CONSTRAINT, '.she/kb.sqlite'), false);
    // Not from an allow-list phrase: not this false positive.
    assert.equal(isAllowListConstraintFalsePositive('不要改动 migrations 目录', 'migrations'), false);
    // Truncated evidence still parses when the verdict's core survived the cut.
    const cut = `${WHITELIST_FP.slice(0, WHITELIST_FP.indexOf('出现在了') + 3)}…`;
    assert.deepEqual(parseReflectionEvidence(cut)?.map((s) => s.kind), ['constraint']);
    assert.equal(parseReflectionEvidence('随便一句话'), null);
  });
});
