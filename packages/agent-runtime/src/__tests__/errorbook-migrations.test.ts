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
import { ErrorBook, isWorthRemembering } from '../errorbook.js';
import { classifyToolResult } from '../tool-result.js';
import type { ErrorbookEngineLike, ErrorbookStoreLike } from '../errorbook.js';
import { detectDrift } from '../reflection.js';
import {
  retireKnownFalsePositives,
  parseReflectionEvidence,
  isAllowListConstraintFalsePositive,
  isToolNamedConstraintFalsePositive,
  isDescriptiveConstraintFalsePositive,
  isToolObjectInArgsFalsePositive,
  migrationsMarkerPath,
  FALSE_POSITIVE_REGISTRY_VERSION,
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
const DRIFT_FP = '最近 5 个动作没有提到目标里的任何词（目标词如：pid、12345、23456）；当前步骤「核对 LSP 与 KB 状态」没有提到目标里的任何词';

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

  it('【第四轮 10a】旧分类器把策略拒绝记成的错题被退役，环境权限不足的留着', () => {
    const kb = fakeEngine();
    const book = new ErrorBook(kb, kb);
    /*
     * 三条真的在评测里出现过的形状：前缀式拒绝、抛出的越界、知识库直读写。旧分类器把它们判成
     * `permission` 并写进了书，于是之后每次查询都在指控一件按设计发生的事。
     */
    const denied = book.record({ tool: 'shell', kind: 'permission', detail: 'DENIED: 路径在工作区外: ..' }).entry;
    const escaped = book.record({ tool: 'fs_read', kind: 'permission', detail: 'Error: Path escapes workspace: ../README.md' }).entry;
    const kbDirect = book.record({
      tool: 'shell', kind: 'permission', detail: 'DENIED: 知识库文件只能通过 kb_* 工具访问：直读直写会跳过共振排序。',
    }).entry;
    // 环境权限不足：今天仍然是 permission，是一件要记住的教训，不能一起退掉。
    const envDenied = book.record({
      tool: 'fs_write', kind: 'permission', detail: "Error: EACCES: permission denied, open '/srv/app/x'",
    }).entry;
    // 一条真正的越权（不是策略拒绝的措辞）也留着。
    const other = book.record({ tool: 'shell', kind: 'nonzero_exit', detail: 'exit code: 1' }).entry;

    const res = retireKnownFalsePositives(kb, kb, { workspaceRoot: ws, kbPath: 'kb.sqlite' });
    assert.equal(res.status, 'ran');
    assert.deepEqual(res.retired.map((r) => r.id).sort(), [denied.id, escaped.id, kbDirect.id].sort());
    assert.match(String(kb.memories.find((m) => m.id === denied.id)!.metadata.errorForgottenReason),
      /policy-denial-as-mistake$/);
    assert.equal(forgotten(kb, envDenied.id), false, '环境拒绝访问是一件真实的教训');
    assert.equal(forgotten(kb, other.id), false);
    assert.equal(book.count(), 2);
  });

  it('退役之后，重新发生同样的拒绝也不会让它回来（它不再进书）', () => {
    const kb = fakeEngine();
    const book = new ErrorBook(kb, kb);
    const denied = book.record({ tool: 'shell', kind: 'permission', detail: 'DENIED: 路径在工作区外: ..' }).entry;
    retireKnownFalsePositives(kb, kb, { workspaceRoot: ws, kbPath: 'kb.sqlite' });
    assert.equal(forgotten(kb, denied.id), true);
    /*
     * 关键的一半：过去"复发会自己回来"是正确的（同样的失败可能真的又一次是 agent 的错）。现在
     * 分类器把这条判成 `policy_denied`，而 `isWorthRemembering` 对它答 false —— 循环根本不会再写
     * 这条记录，所以退役不会被撤销。
     */
    assert.equal(isWorthRemembering(classifyToolResult('shell', 'DENIED: 路径在工作区外: ..').kind), false);
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
    assert.equal(Object.values(marker.errorbook_known_false_positives as Record<string, { registryVersion: number }>)[0].registryVersion, FALSE_POSITIVE_REGISTRY_VERSION);
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

describe('errorbook 迁移：约束里点名「要用」的工具被当成禁止对象（R7）', () => {
  const RULE = '用 shell 跑测试，不要用 fs_write';
  const verdict = (rule: string, object: string, via: string) => `约束「${rule}」排除的对象「${object}」出现在了 ${via} 的调用参数里`;
  let n = 0;
  /** One entry per fresh KB: reflections de-duplicate by topic, so two in one book would merge. */
  const retired = (topic: string, evidence: string) => {
    const kb = fakeEngine();
    const book = new ErrorBook(kb, kb);
    const entry = book.recordReflection({ topic, lesson, evidence }).entry;
    const res = retireKnownFalsePositives(kb, kb, { workspaceRoot: ws, kbPath: `kb-r7-${n++}.sqlite` });
    assert.equal(res.status, 'ran');
    const hit = res.retired.find((r) => r.id === entry.id);
    return hit ? hit.signature : null;
  };

  it('旧判据把「要用的工具」记成越界的条目被退役', () => {
    assert.equal(retired('越过约束', verdict(RULE, 'shell', 'shell')), 'reflection-tool-named-constraint');
    assert.equal(retired('越过约束', verdict('不要用 fs_write，改用 fs_patch', 'fs_patch', 'fs_patch')), 'reflection-tool-named-constraint');
    assert.equal(retired('越过约束', verdict('不要跳过 kb_query', 'kb_query', 'kb_query')), 'reflection-tool-named-constraint');
    assert.equal(retired('目标漂移', verdict("don't use fs_write, use fs_patch instead", 'fs_patch', 'fs_patch')), 'reflection-tool-named-constraint');
  });

  it('真正的越界、和真越界混在一起的证据不退役', () => {
    assert.equal(retired('越过约束', verdict(RULE, 'fs_write', 'fs_write')), null);
    assert.equal(retired('越过约束', verdict('不要用 shell', 'shell', 'shell')), null);
    assert.equal(retired('越过约束', `${verdict(RULE, 'shell', 'shell')}；${verdict(RULE, 'fs_write', 'fs_write')}`), null);
    assert.equal(retired('目标漂移', `${verdict(RULE, 'shell', 'shell')}；已用 40 次工具调用，超过预算的 30 次`), null);
  });

  it('判定细节', () => {
    assert.equal(isToolNamedConstraintFalsePositive(RULE, 'shell'), true);
    assert.equal(isToolNamedConstraintFalsePositive(RULE, 'fs_write'), false);
    assert.equal(isToolNamedConstraintFalsePositive('must call kb_query first, do not read .she/kb.sqlite', 'kb_query'), true);
    assert.equal(isToolNamedConstraintFalsePositive('不要用 shell', 'shell'), false);
    assert.equal(isToolNamedConstraintFalsePositive('不要改动 migrations 目录', 'migrations'), false);
  });
});

describe('errorbook 迁移：描述被当成禁止对象、工具名在别的工具参数里命中（评审轮）', () => {
  const verdict = (rule: string, object: string, via: string) => `约束「${rule}」排除的对象「${object}」出现在了 ${via} 的调用参数里`;
  let n = 0;
  const retired = (topic: string, evidence: string) => {
    const kb = fakeEngine();
    const book = new ErrorBook(kb, kb);
    const entry = book.recordReflection({ topic, lesson, evidence }).entry;
    const res = retireKnownFalsePositives(kb, kb, { workspaceRoot: ws, kbPath: `kb-rv-${n++}.sqlite` });
    assert.equal(res.status, 'ran');
    return res.retired.find((r) => r.id === entry.id)?.signature ?? null;
  };

  it('实测错题本里的那条（7c4e1f9a，两条约束都是描述被当成对象）被退役', () => {
    // portability-check:allow — 被测数据：错题本里那条误报的原文（点名解释器，不是调用）。
    const live = '约束「shell 由 cmd.exe 解析，不能用 POSIX 写法」排除的对象「shell」出现在了 shell 的调用参数里；'
      + '约束「本工作区非 git 仓库、无 package.json，worktree 隔离与依赖扫描不可用，须如实标注不得报 clean」'
      + '排除的对象「package.json」出现在了 fs_read 的调用参数里';
    assert.equal(retired('越过约束', live), 'reflection-descriptive-constraint');
  });

  it('工具名在别的工具参数里命中的旧条目被退役', () => {
    assert.equal(retired('越过约束', verdict('用 shell 跑测试，不要用 fs_write', 'fs_write', 'shell')), 'reflection-tool-object-in-args');
    assert.equal(retired('越过约束', verdict('不要用 shell', 'shell', 'fs_read')), 'reflection-tool-object-in-args');
  });

  it('真越界、允许清单下调用别的工具、描述之外的真对象都留着', () => {
    assert.equal(retired('越过约束', verdict('不要用 shell', 'shell', 'shell')), null);
    assert.equal(retired('越过约束', verdict('只用 shell，不要用别的工具', 'fs_write', 'fs_write')), null);
    // portability-check:allow — 同一句被测数据。
    assert.equal(retired('越过约束', verdict('shell 由 cmd.exe 解析，不能用 POSIX 写法', 'POSIX', 'shell')), null);
    assert.equal(retired('越过约束', verdict('不要用 git', 'git', 'shell')), null);
  });

  it('判定细节', () => {
    // portability-check:allow — 同一句被测数据。
    assert.equal(isDescriptiveConstraintFalsePositive('shell 由 cmd.exe 解析，不能用 POSIX 写法', 'shell'), true);
    assert.equal(isDescriptiveConstraintFalsePositive('x.ts 是生成的，不要改它', 'x.ts'), false);
    assert.equal(isToolObjectInArgsFalsePositive('不要用 shell', 'shell', 'fs_read'), true);
    assert.equal(isToolObjectInArgsFalsePositive('不要用 shell', 'shell', 'shell_wait'), false);
    assert.equal(isToolObjectInArgsFalsePositive('不要改 cluster.ts', 'cluster.ts', 'shell'), false);
  });
});
