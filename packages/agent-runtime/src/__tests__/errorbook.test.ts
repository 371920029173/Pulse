import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ErrorBook,
  ERRORBOOK_ROOT,
  isWorthRemembering,
  renderErrorbook,
} from '../errorbook.js';
import type { ErrorbookEngineLike, ErrorbookStoreLike } from '../errorbook.js';

/**
 * An in-memory stand-in for the KB, holding only what the book touches.
 *
 * A fake rather than the real engine because these assertions are about the BOOK's rules —
 * when a repeat counts up instead of adding a node, where entries are filed, what a lookup
 * returns. The real store is exercised by `scripts/errorbook-check.mjs`, which is the case
 * that proves the two actually fit together.
 */
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

/**
 * The fake plays both halves of the KB (engine and store), so every test hands the same object
 * to both slots. Splitting the fake in two would only restate the production split.
 */
const newBook = (kb: ReturnType<typeof fakeEngine>) => new ErrorBook(kb, kb);

const report = (over: Partial<Parameters<ErrorBook['record']>[0]> = {}) => ({
  tool: 'shell',
  kind: 'nonzero_exit' as const,
  call: 'cmd /c exit 3',
  detail: 'exit code: 3',
  remedy: '读 stderr',
  ...over,
});

describe('ErrorBook 写入', () => {
  it('第一次失败建 groups 和一条记录', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    const { entry, recurring } = book.record(report());

    assert.equal(recurring, false);
    assert.equal(entry.count, 1);
    assert.equal(engine.groups.length, 2, 'errors 根组 + errors/shell 子组');
    assert.deepEqual(engine.groups.map((g) => g.name).sort(), [ERRORBOOK_ROOT, 'shell']);
    assert.equal(engine.memories.length, 1);

    const node = engine.memories[0];
    // `tool_outcome`, not `fact`: an observation about this machine is not a fact about the
    // world, and the book must not be able to answer a question about the world.
    assert.equal(node.kind, 'tool_outcome');
    assert.equal(node.metadata.errorTool, 'shell');
    assert.equal(node.metadata.errorCount, 1);
  });

  it('同一个失败再来一次是加计数，不是多一条', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    book.record(report());
    const second = book.record(report());

    assert.equal(second.recurring, true);
    assert.equal(second.entry.count, 2);
    assert.equal(engine.memories.length, 1, '重复不能变成两条：那样重复本身会把它自己埋掉');
    assert.equal(engine.memories[0].accessCount, 1, '重复是「这条重要」的证据，要被提升');
    assert.match(engine.memories[0].content, /出现次数：/);
    assert.match(engine.memories[0].title, /2 次/);
  });

  it('不同的输出算不同的错误', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    book.record(report({ detail: 'exit code: 3' }));
    book.record(report({ detail: 'exit code: 7' }));
    assert.equal(engine.memories.length, 2);
  });

  it('空白差异不算不同的错误', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    book.record(report({ detail: 'exit   code:  3' }));
    book.record(report({ detail: 'exit code: 3\n' }));
    assert.equal(engine.memories.length, 1);
  });

  it('没有工具名也归档，不能丢', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    book.record(report({ tool: '   ' }));
    assert.deepEqual(engine.groups.map((g) => g.name).sort(), [ERRORBOOK_ROOT, 'unknown']);
  });

  it('同一条会话里的两次失败用 co_occurrence 连起来（只连相邻的一对）', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    book.record(report({ detail: 'first', sessionId: 's1' }));
    book.record(report({ detail: 'second', sessionId: 's1' }));
    book.record(report({ detail: 'third', sessionId: 's1' }));

    assert.equal(engine.edges.length, 2, '三次失败两条边，不是完全图');
    assert.ok(engine.edges.every((e) => e.kind === 'co_occurrence'),
      '只能说「一起出现过」，不能说「A 导致 B」');
  });

  it('没有会话就不连边', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    book.record(report({ detail: 'first' }));
    book.record(report({ detail: 'second' }));
    assert.equal(engine.edges.length, 0);
  });

  it('连边失败不能把已经写下的记录搞掉', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    book.record(report({ detail: 'first', sessionId: 's1' }));
    engine.setFailEdges(true);
    const second = book.record(report({ detail: 'second', sessionId: 's1' }));
    assert.equal(engine.memories.length, 2);
    assert.equal(second.entry.count, 1);
  });
});

describe('ErrorBook 读取', () => {
  it('按工具查，次数多的排前面', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    book.record(report({ tool: 'shell', detail: 'a' }));
    book.record(report({ tool: 'shell', detail: 'b' }));
    book.record(report({ tool: 'shell', detail: 'b' }));
    book.record(report({ tool: 'grep', detail: 'c' }));

    const rows = book.lookup({ tool: 'shell' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].detail, 'b');
    assert.equal(rows[0].count, 2);
    assert.equal(rows[0].group, `${ERRORBOOK_ROOT}/shell`);
    assert.ok(!rows.some((r) => r.detail === 'c'), '查 shell 不能返回 grep 的记录');
  });

  it('查不存在的工具返回空，不是全部', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    book.record(report());
    assert.deepEqual(book.lookup({ tool: 'never_used' }), []);
  });

  it('空的时候查也不炸', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    assert.deepEqual(book.lookup({ tool: 'shell' }), []);
    assert.deepEqual(book.lookup({ query: 'anything' }), []);
    assert.deepEqual(book.lookup(), []);
  });

  it('自由查询只认错题本里的节点', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    const { entry } = book.record(report());

    // Retrieval is KB-wide, so it can hand back a node from a fact group that merely shares a
    // word. Answering "have I been here before?" with that would be a false memory.
    engine.setQueryNodes([
      { id: entry.id, title: 't', content: 'c', kind: 'tool_outcome', path: `errors,${ERRORBOOK_ROOT}/shell` },
      { id: 'outside', title: 't2', content: 'c2', kind: 'fact', path: 'docs,notes' },
    ]);
    const rows = book.lookup({ query: 'exit code' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, entry.id);
  });

  it('自由查询没匹配就是空，不拿别的记录来凑数', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    book.record(report());
    engine.setQueryNodes([{ id: 'outside', title: 't', content: 'c', kind: 'fact', path: 'notes' }]);
    assert.deepEqual(book.lookup({ query: 'nothing like this' }), []);
  });

  it('不带条件时按时间倒序给最新的', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    book.record(report({ tool: 'a', detail: 'older' }));
    book.record(report({ tool: 'b', detail: 'newer' }));
    const rows = book.lookup({ limit: 10 });
    assert.equal(rows[0].detail, 'newer', '最新的排前面');
    assert.equal(book.count(), 2);
  });
});

describe('isWorthRemembering', () => {
  it('记的是「做错了」，不是「碰上了」', () => {
    for (const kind of ['invalid_args', 'permission', 'unavailable', 'not_found', 'nonzero_exit', 'unknown', 'stuck_loop'] as const) {
      assert.equal(isWorthRemembering(kind), true, `${kind} 该记`);
    }
    for (const kind of ['none', 'empty', 'precondition', 'service', 'timeout', 'rate_limited'] as const) {
      assert.equal(isWorthRemembering(kind), false, `${kind} 不该记`);
    }
  });
});

describe('renderErrorbook', () => {
  it('重复过的条目要标出来', () => {
    const engine = fakeEngine();
    const book = newBook(engine);
    book.record(report({ detail: 'once' }));
    book.record(report({ detail: 'twice' }));
    book.record(report({ detail: 'twice' }));
    const text = renderErrorbook(book.lookup({ tool: 'shell' }));
    assert.match(text, /- shell · nonzero_exit（已出现 2 次）：twice/);
    assert.match(text, /- shell · nonzero_exit：once/);
  });

  it('没有条目就是空串（调用方可以直接拼进提示词）', () => {
    assert.equal(renderErrorbook([]), '');
  });
});
