import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { repairApiMessages } from '../protocol.js';

describe('发给接口前的对话修复', () => {
  it('空的助手消息补上正文，避免 content or tool_calls 400', () => {
    const out = repairApiMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', reasoning: '只想了一下' },
      { role: 'assistant', content: '   ' },
    ]);
    assert.equal(out[1].content, '只想了一下');
    assert.equal(out[2].content, '…');
  });

  it('没有结果的工具调用改写成正文，不再带着悬空的 tool_calls', () => {
    const out = repairApiMessages([
      { role: 'user', content: '跑一下' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
      },
    ]);
    assert.equal(out[1].tool_calls, undefined);
    assert.match(out[1].content, /shell/);
  });

  it('配好对的工具调用原样保留', () => {
    const call = { id: 'c1', type: 'function' as const, function: { name: 'shell', arguments: '{}' } };
    const out = repairApiMessages([
      { role: 'assistant', content: 'calling', tool_calls: [call] },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    ]);
    assert.equal(out[0].tool_calls?.length, 1);
    assert.equal(out[1].role, 'tool');
    assert.equal(out[1].tool_call_id, 'c1');
  });
});
