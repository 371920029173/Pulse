/**
 * Conversation migration: parsed chunks back into a real conversation.
 *
 * The parsers were written for knowledge ingestion, where the speaker was metadata on a chunk. A
 * migration needs the speaker to be STRUCTURE, so this reads it back. Three properties matter and
 * each is a way to lose or distort the user's history:
 *
 *   1. An unrecognised role must not drop the turn. Sources use their own vocabulary (`human`, `ai`,
 *      `model`, `message`, `item`, …) and the parsers pass it through verbatim; silently discarding
 *      what we do not recognise would quietly shorten the conversation.
 *   2. Adjacent same-role turns must merge. Some exports split one reply across several entries, and
 *      two consecutive "user" turns misreport who said what.
 *   3. Truncation must be REPORTED. A capped transcript that looks complete is worse than one that
 *      says it was capped.
 */
import { describe, it } from 'node:test';
import assertStrict from 'node:assert/strict';
import { chunksToMessages } from '../contextParsers.js';

const chunk = (role: string, content: string) => ({ title: 'x', content, meta: { source: 'test', role } });

describe('chunksToMessages', () => {
  it('user / human 归为用户', () => {
    const { messages } = chunksToMessages([chunk('user', 'a'), chunk('human', 'b')]);
    // Consecutive same-role merge, so this is one user turn.
    assertStrict.equal(messages.length, 1);
    assertStrict.equal(messages[0].role, 'user');
    assertStrict.equal(messages[0].content, 'a\n\nb');
  });

  it('assistant / ai / model 归为助手', () => {
    const { messages } = chunksToMessages([chunk('assistant', 'a'), chunk('ai', 'b'), chunk('model', 'c')]);
    assertStrict.equal(messages.length, 1);
    assertStrict.equal(messages[0].role, 'assistant');
  });

  it('【关键】未知角色不会被丢弃（丢失内容才是移植最不能犯的错）', () => {
    for (const role of ['message', 'item', 'system', 'tool', 'whatever', '']) {
      const { messages } = chunksToMessages([chunk(role, `来自 ${role || '(空)'}`)]);
      assertStrict.equal(messages.length, 1, `角色 ${JSON.stringify(role)} 的回合被丢了`);
      assertStrict.match(String(messages[0].content), /来自/);
    }
  });

  it('【关键】相邻同角色回合合并（否则"谁说的"会失真）', () => {
    const { messages } = chunksToMessages([
      chunk('user', '第一句'),
      chunk('user', '第二句'),
      chunk('assistant', '回复'),
    ]);
    assertStrict.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
    assertStrict.equal(messages[0].content, '第一句\n\n第二句');
  });

  it('交替回合保持交替', () => {
    const { messages } = chunksToMessages([
      chunk('user', 'u1'), chunk('assistant', 'a1'), chunk('user', 'u2'), chunk('assistant', 'a2'),
    ]);
    assertStrict.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  });

  it('空白内容被跳过', () => {
    const { messages } = chunksToMessages([chunk('user', '   '), chunk('assistant', 'real')]);
    assertStrict.equal(messages.length, 1);
    assertStrict.equal(messages[0].content, 'real');
  });

  it('超过上限时保留前 N 条并报告丢弃数量', () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      chunk(i % 2 === 0 ? 'user' : 'assistant', `t${i}`));
    const { messages, truncated } = chunksToMessages(chunks, 4);
    assertStrict.equal(messages.length, 4);
    assertStrict.equal(truncated, 6, '必须报告被丢弃的数量');
    assertStrict.equal(messages[0].content, 't0', '保留的是最前面的回合');
  });

  it('未超限时 truncated 为 0（而不是负数）', () => {
    const { truncated } = chunksToMessages([chunk('user', 'a')], 10);
    assertStrict.equal(truncated, 0);
  });

  it('空输入返回空，不抛异常', () => {
    const { messages, truncated } = chunksToMessages([]);
    assertStrict.deepEqual(messages, []);
    assertStrict.equal(truncated, 0);
  });

  it('合并后仍然遵守上限（上限按合并后的回合数算）', () => {
    // 12 same-role chunks would merge to 1, so a cap of 5 must not split it.
    const chunks = Array.from({ length: 12 }, () => chunk('user', 'x'));
    const { messages, truncated } = chunksToMessages(chunks, 5);
    assertStrict.equal(messages.length, 1);
    assertStrict.equal(truncated, 0);
  });
});
