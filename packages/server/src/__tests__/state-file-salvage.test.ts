/**
 * 损坏状态文件的抢救：加载时"尽量读回"，而不是从空开始。
 *
 * 这些判据来自一次真实事故（2026-10-11）：蓝屏把 21 MB 的 sessions.json 写坏 —— 文件在、
 * 大小对，尾部 43% 全是 NUL。当时的加载器只能说一句"不是合法 JSON"，于是从空开始 ——
 * 用户的整段对话在界面上消失，尽管 57% 的数据完好躺在盘上。字节是安全的，是没人能读它们。
 *
 * 所以这里验两件事，缺一不可：
 *   · 能证明完整的部分必须被读回来（torn/NUL/截断在干净点/带 BOM/嵌套）；
 *   · 原文必须原封不动留底（抢救只决定"读什么"，绝不决定"留什么"）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadStateFile, salvageJsonPrefix } from '../state-file.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'she-salvage-'));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  file = join(dir, 'sub', 'state.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Doc { schema_version: string; items: string[] }

const SPEC = {
  version: 'v2',
  empty: (): Doc => ({ schema_version: 'v2', items: [] }),
  parse: (raw: unknown): Doc => {
    const d = raw as Doc;
    if (!Array.isArray(d.items)) throw new Error('items 不是数组');
    return { schema_version: 'v2', items: d.items.filter((i): i is string => typeof i === 'string') };
  },
};

describe('salvageJsonPrefix：只保留「证明完整」的部分', () => {
  it('NUL 尾巴（断电写坏的样子）→ 截到最后一条完整值并补上括号', () => {
    const torn = '{"schema_version":"v2","items":["one","two","thr' + '\u0000'.repeat(40);
    const s = salvageJsonPrefix(torn);
    assert.ok(s, '应该能救');
    assert.deepEqual(JSON.parse(s.text), { schema_version: 'v2', items: ['one', 'two'] });
    assert.ok(s.dropped > 0, '丢弃的尾部要如实报出来');
  });

  it('嵌套容器里被截断 → 补上对应的 ] 与 }', () => {
    const s = salvageJsonPrefix('{"a":{"b":[1,2,3');
    assert.ok(s);
    assert.deepEqual(JSON.parse(s.text), { a: { b: [1, 2, 3] } });
  });

  it('截断在干净点（只是少了结尾括号）也要能救', () => {
    const s = salvageJsonPrefix('{"schema_version":"v2","items":["one","two"]');
    assert.ok(s);
    assert.deepEqual(JSON.parse(s.text), { schema_version: 'v2', items: ['one', 'two'] });
  });

  it('字符串中间被截断 → 回到上一个完整值，不留下半截字符串', () => {
    const s = salvageJsonPrefix('{"a":"x","b":"y');
    assert.ok(s);
    assert.deepEqual(JSON.parse(s.text), { a: 'x' });
  });

  it('键写了一半就没了 → 退回上一个完整值（键和值在字节上分不出来，不许猜）', () => {
    const s = salvageJsonPrefix('{"a":1,"b"');
    assert.ok(s);
    assert.deepEqual(JSON.parse(s.text), { a: 1 });
  });

  it('带 BOM 的文档不算坏：BOM 不参与判定', () => {
    const s = salvageJsonPrefix('\ufeff{"a":[1,2,');
    assert.ok(s);
    assert.deepEqual(JSON.parse(s.text), { a: [1, 2] });
  });

  it('开头就坏 → 救不了，返回 null（交给隔离）', () => {
    assert.equal(salvageJsonPrefix('{oops'), null);
    assert.equal(salvageJsonPrefix('这不是 JSON'), null);
  });

  it('没坏的文档不动它（返回 null，不许"顺手重写"健康文件）', () => {
    assert.equal(salvageJsonPrefix('{"a":1}'), null);
    assert.equal(salvageJsonPrefix('[1,2,3]'), null);
    assert.equal(salvageJsonPrefix('  {"a": 1}  '), null);
  });
});

describe('加载：损坏文件先抢救，再隔离', () => {
  it('断电写坏的会话文件：完整部分读回来，原文一个字节不动地留底', () => {
    const torn = '{"schema_version":"v2","items":["one","two","thr' + '\u0000'.repeat(40);
    writeFileSync(file, torn, 'utf8');

    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.deepEqual(r.data.items, ['one', 'two'], '能读回来的部分必须读回来');
    assert.ok(r.recovered, '必须报告发生了恢复');
    assert.match(r.recovered.reason, /已尽力恢复/);
    assert.equal(readFileSync(r.recovered.backup, 'utf8'), torn, '备份必须是原文逐字节');

    const again = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.deepEqual(again.data.items, [], '隔离之后原路径是空的（由调用方决定何时写入新状态）');
  });

  it('抢救出来的内容也要过本存储自己的形状校验；过不了就不假装救回来了', () => {
    // items 在，但被截断到只剩一个数字——parse 会把它过滤掉，救回来的是空列表而不是坏列表
    writeFileSync(file, '{"schema_version":"v2","items":[1,2,3', 'utf8');
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.deepEqual(r.data.items, []);
    assert.match(r.recovered!.reason, /已尽力恢复/);
  });

  it('整份都是垃圾 → 隔离 + 空值，且不许声称"已尽力恢复"', () => {
    writeFileSync(file, '{oops', 'utf8');
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.deepEqual(r.data.items, []);
    assert.ok(r.recovered);
    assert.doesNotMatch(r.recovered.reason, /已尽力恢复/);
    assert.equal(readFileSync(r.recovered.backup, 'utf8'), '{oops');
  });

  it('完好的文件照旧正常加载，不触发恢复路径', () => {
    writeFileSync(file, JSON.stringify({ schema_version: 'v2', items: ['a', 'b'] }), 'utf8');
    const r = loadStateFile<Doc>({ path: file, ...SPEC });
    assert.deepEqual(r.data.items, ['a', 'b']);
    assert.equal(r.recovered, undefined);
    assert.ok(existsSync(file), '健康文件不该被移走');
  });
});
