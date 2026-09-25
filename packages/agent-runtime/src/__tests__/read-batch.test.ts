/**
 * Which calls may overlap, and which query counts as "the same one".
 *
 * The failure this file is really about is a stale read that looks exactly like a correct one.
 * Reading three files at once is a latency fix; reading a file BEFORE the write in the same
 * message would hand the model the old contents with no way for it to tell — the class of bug
 * that makes a fast agent look confident and be wrong.
 *
 * So the assertions are shaped around the boundaries: the prefix stops at the first non-read, an
 * unknown tool is serial, and two identical arguments are one query however the JSON was
 * serialised (the model re-serialises the object every round, and key order is not part of what it
 * asked for).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PARALLEL_READS,
  READ_ONLY_TOOLS,
  inWaves,
  isReadOnlyTool,
  queryKey,
  readsToPrefetch,
  stableStringify,
} from '../read-batch.js';

const noCache = () => false;

describe('只读分类：未知一律按串行处理', () => {
  it('认得出常见的只读工具', () => {
    for (const name of ['fs_read', 'fs_list', 'grep', 'kb_query', 'git_diff', 'git_log', 'errorbook_lookup', 'plan_list']) {
      assert.equal(isReadOnlyTool(name), true, `${name} 应当是只读的`);
    }
  });

  it('【关键】写、暂停、生成、外部调用都不是只读', () => {
    for (const name of ['fs_write', 'shell', 'ask_user', 'task_spawn', 'report_write', 'plan_update', 'kb_upsert', 'memo_add', 'schedule_create', 'preflight_record', 'computer_click', 'kb_ingest_scan']) {
      assert.equal(isReadOnlyTool(name), false, `${name} 不该被当成只读`);
    }
  });

  it('【关键】没见过的名字（插件 / MCP / 以后新增的）默认串行', () => {
    /*
     * The allowlist is the safety mechanism. A plugin tool that happens to be called
     * `fs_read_v2` or an MCP tool called `read_file` must not be assumed harmless, because the
     * cost of being wrong is a corrupted turn and the cost of being cautious is milliseconds.
     */
    for (const name of ['plugin_whatever', 'mcp__read_file', 'read_file', 'fs_read_v2', '']) {
      assert.equal(isReadOnlyTool(name), false);
    }
  });

  it('刻意排除的那几个有理由：截图会写文件、LSP 冷启动会抢跑、视觉要花模型额度', () => {
    for (const name of ['screenshot', 'vision_describe', 'lsp_diagnostics', 'lsp_hover']) {
      assert.equal(READ_ONLY_TOOLS.has(name), false, `${name} 不该在并发白名单里`);
    }
  });
});

describe('查询身份：同一件事就是同一个 key', () => {
  it('键序不同但内容相同的参数算同一个查询', () => {
    const a = queryKey('fs_read', '{"path":"a.ts","start":1}');
    const b = queryKey('fs_read', '{"start":1,"path":"a.ts"}');
    assert.equal(a, b);
  });

  it('嵌套对象与数组同样稳定', () => {
    assert.equal(
      queryKey('kb_query', '{"q":"x","opts":{"b":2,"a":[{"y":1,"x":2}]}}'),
      queryKey('kb_query', '{"opts":{"a":[{"x":2,"y":1}],"b":2},"q":"x"}'),
    );
  });

  it('工具名不同就不是同一个查询', () => {
    assert.notEqual(queryKey('fs_read', '{"path":"a"}'), queryKey('fs_list', '{"path":"a"}'));
  });

  it('参数不同就不是同一个查询', () => {
    assert.notEqual(queryKey('fs_read', '{"path":"a"}'), queryKey('fs_read', '{"path":"b"}'));
  });

  it('解析不了的 arguments 退回原文，不抛错', () => {
    assert.equal(queryKey('fs_read', 'not json'), 'fs_read\u0000not json');
  });

  it('`_` 前缀的键不算模型请求的一部分', () => {
    /*
     * `_stage` / `_confirm_ticket` are the agent's own adjustments. Including them would make the
     * same logical read miss the cache whenever staging changed, and would let a model-supplied
     * ticket change the identity of a call.
     */
    assert.equal(queryKey('fs_read', '{"path":"a"}'), queryKey('fs_read', '{"path":"a","_stage":true}'));
  });

  it('stableStringify 对 null / undefined 不炸', () => {
    assert.equal(stableStringify(null), 'null');
    assert.equal(stableStringify({ a: undefined }), '{"a":null}');
  });
});

describe('并发波次：有上限，不乱序', () => {
  it('按上限切分并保持顺序', () => {
    assert.deepEqual(inWaves([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it('上限至少为 1（0 会变成死循环）', () => {
    assert.deepEqual(inWaves([1, 2], 0), [[1], [2]]);
  });

  it('默认上限是个小数，不是「全部一起上」', () => {
    assert.ok(MAX_PARALLEL_READS >= 2 && MAX_PARALLEL_READS <= 8, `上限 ${MAX_PARALLEL_READS} 应当是小而有限的`);
    assert.deepEqual(inWaves(new Array(9).fill('x')).map((w) => w.length), [MAX_PARALLEL_READS, MAX_PARALLEL_READS, 1]);
  });
});

describe('预取范围：只取开头连续的只读调用', () => {
  const calls = (...names: string[]) => names.map((name) => ({ name, rawArgs: '{}' }));

  it('全是只读时全部预取', () => {
    const refs = readsToPrefetch(calls('fs_read', 'grep', 'kb_query'), noCache);
    assert.deepEqual(refs.map((r) => r.index), [0, 1, 2]);
  });

  it('【关键】遇到写就停：写之后的读不能提前跑，否则读到的是写之前的内容', () => {
    const refs = readsToPrefetch(calls('fs_read', 'fs_write', 'fs_read'), noCache);
    assert.deepEqual(refs.map((r) => r.index), [0], '写后面的读必须留给串行路径');
  });

  it('第一个就是非只读时不预取任何东西', () => {
    assert.deepEqual(readsToPrefetch(calls('shell', 'fs_read'), noCache), []);
  });

  it('非只读但会暂停/生成的工具同样截断前缀（保守）', () => {
    const refs = readsToPrefetch(calls('fs_read', 'task_spawn', 'grep'), noCache);
    assert.deepEqual(refs.map((r) => r.index), [0]);
  });

  it('完全未知的工具名也截断', () => {
    assert.deepEqual(readsToPrefetch(calls('fs_read', 'plugin_thing', 'grep'), noCache).map((r) => r.index), [0]);
  });

  it('【关键】前缀里的重复查询只预取一次（一次读取，两个调用复用）', () => {
    const refs = readsToPrefetch(calls('fs_read', 'fs_read', 'grep'), noCache);
    assert.equal(refs.length, 2, '同一个查询只该有一个 promise');
    assert.deepEqual(refs.map((r) => r.index), [0, 2]);
  });

  it('这一轮已经答过的查询不再预取（复用即可）', () => {
    const cached = (key: string) => key === queryKey('fs_read', '{}');
    assert.deepEqual(readsToPrefetch(calls('fs_read', 'grep'), cached).map((r) => r.index), [1]);
  });

  it('key 与查询身份一致，便于串行路径回填缓存', () => {
    const refs = readsToPrefetch(calls('grep'), noCache);
    assert.equal(refs[0].key, queryKey('grep', '{}'));
  });
});
