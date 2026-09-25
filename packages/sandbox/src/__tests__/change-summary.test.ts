import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeChange, MAX_DIFF_LINES } from '../change-summary.js';

describe('直写前后对比', () => {
  it('内容一字未改时明说没变，而不是回一句字节数', () => {
    const body = 'a\nb\nc\n';
    const s = summarizeChange('app.ts', body, body);
    assert.equal(s.status, 'same');
    assert.equal(s.added, 0);
    assert.equal(s.removed, 0);
    assert.match(s.text, /完全相同/);
    assert.match(s.text, /3 行/);
  });

  it('新建文件只报行数与字符数，不回灌内容', () => {
    const s = summarizeChange('new.ts', '', 'line1\nline2\n');
    assert.equal(s.status, 'new');
    assert.equal(s.added, 2);
    assert.match(s.text, /新建文件/);
    // 内容本身就是模型刚写出来的，回灌一遍纯属浪费上下文。
    assert.ok(!s.text.includes('+line1'));
  });

  it('只改动中间一段时裁掉相同前后缀，只显示差异', () => {
    const before = ['head', 'keep1', 'old-a', 'old-b', 'keep2', 'tail'].join('\n');
    const after = ['head', 'keep1', 'new-a', 'keep2', 'tail'].join('\n');
    const s = summarizeChange('mid.ts', before, after);
    assert.equal(s.status, 'changed');
    assert.equal(s.removed, 2);
    assert.equal(s.added, 1);
    assert.match(s.text, /^-old-a$/m);
    assert.match(s.text, /^-old-b$/m);
    assert.match(s.text, /^\+new-a$/m);
    // 相同的前后缀不该出现在 diff 里。
    assert.ok(!/^[-+ ]head$/m.test(s.text), `不该包含未变行: ${s.text}`);
    assert.ok(!/^[-+ ]tail$/m.test(s.text), `不该包含未变行: ${s.text}`);
  });

  it('改动被未变行隔开时各自成块，而不是糊成一坨', () => {
    const before = ['x1', 'x2', 'same', 'y1', 'y2'].join('\n');
    const after = ['X1', 'x2', 'same', 'Y1', 'y2'].join('\n');
    const s = summarizeChange('blocks.ts', before, after);
    assert.equal(s.added, 2);
    assert.equal(s.removed, 2);
    assert.match(s.text, /^ same$/m, `未变的中间行应作为上下文保留: ${s.text}`);
  });

  it('差异区域过大时不再逐行展开，只报计数', () => {
    const before = Array.from({ length: 500 }, (_, i) => `old-${i}`).join('\n');
    const after = Array.from({ length: 500 }, (_, i) => `new-${i}`).join('\n');
    const s = summarizeChange('huge.ts', before, after);
    assert.equal(s.status, 'changed');
    assert.equal(s.truncated, true);
    assert.equal(s.added, 500);
    assert.equal(s.removed, 500);
    assert.match(s.text, /改动范围过大/);
  });

  it('差异行数超过上限时截断，并且在文本里承认截断', () => {
    const before = Array.from({ length: 200 }, (_, i) => `a${i}`).join('\n');
    const after = Array.from({ length: 200 }, (_, i) => `b${i}`).join('\n');
    const s = summarizeChange('cut.ts', before, after);
    assert.equal(s.truncated, true);
    assert.match(s.text, /已截断/);
    // 输出不该超过上限太多（正文 + 头部 + 截断说明）。
    assert.ok(s.text.length < 2400 + 200, `输出过长: ${s.text.length}`);
  });

  it('空文件写入内容算有一次改动，而不是“完全相同”', () => {
    const s = summarizeChange('empty.ts', '', 'now has content\n');
    assert.notEqual(s.status, 'same');
    assert.match(s.text, /新建文件/);
  });

  it('从有内容改成空文件报出全部删除', () => {
    const s = summarizeChange('gone.ts', 'a\nb\nc', '');
    assert.equal(s.status, 'changed');
    assert.equal(s.removed, 3);
    assert.equal(s.added, 0);
  });

  it('报告的行数上限是常量而非魔数', () => {
    assert.equal(typeof MAX_DIFF_LINES, 'number');
    assert.ok(MAX_DIFF_LINES > 0);
  });
});
