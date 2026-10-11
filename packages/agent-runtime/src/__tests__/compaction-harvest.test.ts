/**
 * 「压缩不丢东西」的判据：候选怎么挑、什么时候不印、以及抬头**逐字节稳定**。
 *
 * 最后一条是这次改动最容易踩坏的地方：候选块在压缩记录里，而压缩记录在每一轮请求的前缀里
 * （digestMessage 的注释：抬头一次写成、之后逐字节不变）。所以这里断言：同一份 state 渲染两次
 * 必须逐字节相同 —— 一旦有人把候选改成"每轮重算"，这条会红。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { kbCandidates, digestMessage } from '../compaction.js';

const m = (role: string, content: string) => ({ role, content }) as never;
const history = (...msgs: Array<[string, string]>) => msgs.map(([r, c]) => m(r, c));

const state = (over: Record<string, unknown> = {}) => ({
  digest: '这段是摘要正文。'.repeat(8),
  covered: 4,
  source: 'model' as const,
  at: '2026-10-11T00:00:00.000Z',
  sourcePath: '.she/sessions/s/compacted/x.jsonl',
  anchors: ['packages/kb/src/store.ts'],
  ...over,
});

describe('压缩候选（该记住的）', () => {
  it('挑得出决定类的那一条，并写清是命中哪一类', () => {
    const got = kbCandidates(history(
      ['user', 'block 0 ' + 'x'.repeat(200)],
      ['assistant', 'ack 0'],
      ['user', '约定：界面文案一律走 t()，棘轮基线只许降不许升。'],
    ));
    assert.equal(got.length, 1);
    assert.match(got[0]!.why, /约定/);
    assert.equal(got[0]!.at, 2, '要带条号，方便回原文核对');
    assert.match(got[0]!.title, /一律走 t\(\)/);
  });

  it('结构化正文（工具回执那种 JSON）不算结论', () => {
    const got = kbCandidates(history(
      ['assistant', '{"decision":"端口 5577 是 UI 的","note":"配置里的默认值"}'],
    ));
    assert.deepEqual(got, []);
  });

  it('太短的、没标记的都不要', () => {
    const got = kbCandidates(history(
      ['user', '好的'],
      ['assistant', '收到'],
      ['assistant', '这一轮的输出是 42 行'],
    ));
    assert.deepEqual(got, []);
  });

  it('有上限（候选块是要被读的，不是归档）', () => {
    const many = Array.from({ length: 20 }, (_, i) => ['user', `约定 ${i}：端口一律用 45${String(i).padStart(2, '0')}。`] as [string, string]);
    const got = kbCandidates(history(...many), 6);
    assert.equal(got.length, 6);
  });

  it('空输入不炸', () => {
    assert.deepEqual(kbCandidates([]), []);
  });
});

describe('压缩记录里的候选块', () => {
  it('有候选时印出来，并要求先查证再补记', () => {
    const msg = digestMessage(state({
      kbCandidates: [{ at: 2, role: 'user', title: '约定：界面文案一律走 t()', why: '约定' }],
    }) as never);
    assert.match(String(msg.content), /^\[压缩记录\]/);
    assert.match(String(msg.content), /kb_query/);
    assert.match(String(msg.content), /kb_upsert/);
    assert.match(String(msg.content), /约定：界面文案一律走 t\(\)/);
  });

  it('没候选就不印（空表会被读成"有线索"）', () => {
    const msg = digestMessage(state({ kbCandidates: [] }) as never);
    assert.doesNotMatch(String(msg.content), /kb_upsert/);
    const none = digestMessage(state() as never);
    assert.doesNotMatch(String(none.content), /kb_upsert/);
  });

  it('同一份 state 渲染两次逐字节相同（它在新前缀里，不许每轮重算）', () => {
    const s = state({ kbCandidates: [{ at: 1, role: 'assistant', title: '决定：走 t()', why: '决定' }] }) as never;
    assert.equal(digestMessage(s).content, digestMessage(s).content);
  });
});
