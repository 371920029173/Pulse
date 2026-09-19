/**
 * Context compaction, and the property it exists to protect.
 *
 * Prompt caching is prefix-based: an append keeps the cached prefix, while
 * changing the front destroys it (measured — see docs/context-and-caching.md).
 * So the tests that matter are not "does it shrink the request" but:
 *
 *   1. the digest is FROZEN — the same span always yields identical bytes
 *   2. the digest is APPEND-ONLY — a later compaction extends it rather than
 *      rewriting it, so the leading bytes stay a valid cache prefix
 *   3. `history` is never mutated — compaction is a request-assembly concern
 *
 * Uses a stub provider so no API calls are made.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../agent.js';
import type { LLMMessage, StreamChunk, ToolDefinition, LLMProvider } from '@she/shared';

/** Records what it was asked to send, so compaction is observable. */
class RecordingProvider implements LLMProvider {
  name = 'stub';
  sent: LLMMessage[][] = [];
  constructor(private replyText = 'ok') {}

  async chat(messages: LLMMessage[], _tools?: ToolDefinition[], onChunk?: (c: StreamChunk) => void): Promise<LLMMessage> {
    this.sent.push(messages.map((m) => ({ ...m })));
    onChunk?.({ type: 'usage', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
    return { role: 'assistant', content: this.replyText };
  }
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-compact-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Minimal config stub; only the fields Agent touches. */
function makeConfig() {
  return {
    llm: { provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k', maxTokens: 100, temperature: 0, thinkingLevel: 'low' },
    workspace: { root: dir },
    kb: { dbPath: join(dir, 'kb.sqlite'), maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100, boostOnAccess: 1.5, pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 } },
    skills: { profile: 'dev' },
    automationMode: true,
    server: { port: 0, host: '127.0.0.1' },
    sandbox: { shell: 'auto', timeout: 1000, maxOutputBytes: 1000, denyDestructiveByDefault: true, allowAllCommands: true },
  } as never;
}

/** An agent whose provider is swapped for the recorder after construction. */
function makeAgent(provider: RecordingProvider) {
  const a = new Agent(makeConfig(), { } as never, { definitions: [], execute: async () => '' } as never, null);
  (a as unknown as { provider: LLMProvider }).provider = provider;
  return a;
}

/** Append messages to an agent's history (history has no public append). */
function push(agent: Agent, ...msgs: LLMMessage[]) {
  agent.setHistory([...agent.getHistory(), ...msgs]);
}

/** Push enough bulk into history to cross the compaction trigger (~120k chars). */
function fillBulk(agent: Agent, blocks: number, charsPer = 10_000) {
  for (let i = 0; i < blocks; i++) {
    push(agent,
      { role: 'user', content: `block ${i} ` + 'x'.repeat(charsPer) },
      { role: 'assistant', content: `ack ${i}` },
    );
  }
}

describe('compaction keeps the request prefix stable', () => {
  it('does not compact below the trigger', async () => {
    const p = new RecordingProvider();
    const a = makeAgent(p);
    push(a, { role: 'user', content: 'small' });
    await a.chat('hello');
    const last = p.sent[p.sent.length - 1];
    assert.ok(!last.some((m) => /压缩记录/.test(m.content)), '小历史不该触发压缩');
  });

  it('compacts once the history is large', async () => {
    const p = new RecordingProvider();
    const a = makeAgent(p);
    fillBulk(a, 14); // ~140k chars, over the 120k trigger
    await a.chat('hello');
    const last = p.sent[p.sent.length - 1];
    assert.ok(last.some((m) => /压缩记录/.test(m.content)), '大历史应被压缩');
  });

  it('the digest is byte-identical across turns (frozen)', async () => {
    const p = new RecordingProvider();
    const a = makeAgent(p);
    fillBulk(a, 14);
    await a.chat('first');
    await a.chat('second');
    await a.chat('third');

    const digestOf = (msgs: LLMMessage[]) => msgs.find((m) => /压缩记录/.test(m.content))?.content ?? '';
    const d1 = digestOf(p.sent[p.sent.length - 3]);
    const d2 = digestOf(p.sent[p.sent.length - 2]);
    const d3 = digestOf(p.sent[p.sent.length - 1]);
    assert.equal(d1, d2, '摘要必须冻结 —— 每轮重算会让前缀变化，缓存全失效');
    assert.equal(d2, d3);
  });

  it('the request is append-only while under the trigger again', async () => {
    const p = new RecordingProvider();
    const a = makeAgent(p);
    fillBulk(a, 14);
    await a.chat('one');
    await a.chat('two');

    const prev = p.sent[p.sent.length - 2];
    const next = p.sent[p.sent.length - 1];
    // Every message of the previous request must be a prefix of the next one —
    // that is exactly what a prefix cache needs.
    for (let i = 0; i < prev.length; i++) {
      assert.equal(next[i]?.content, prev[i].content, `第 ${i} 条消息变了，缓存前缀被破坏`);
      assert.equal(next[i]?.role, prev[i].role);
    }
    assert.ok(next.length > prev.length, '应该是在末尾追加');
  });

  it('leaves `history` intact — compaction is request-only', async () => {
    const p = new RecordingProvider();
    const a = makeAgent(p);
    fillBulk(a, 14);
    const before = a.getHistory().length;
    await a.chat('hello');
    const after = a.getHistory();
    assert.ok(after.length > before, '历史应继续增长，不被截断');
    assert.ok(after.some((m) => m.content.includes('block 0')), '最早的消息仍在本地历史里');
  });

  it('never starts the tail with an orphan tool result', async () => {
    const p = new RecordingProvider();
    const a = makeAgent(p);
    // A tool result with no preceding assistant message would be rejected by the
    // API, so the cut must skip past it.
    fillBulk(a, 13);
    push(a,
      { role: 'user', content: 'x'.repeat(9_000) },
      { role: 'tool', content: 'orphan result', tool_call_id: 't1' },
      { role: 'user', content: 'last' },
    );
    await a.chat('go');
    const msgs = p.sent[p.sent.length - 1];
    const firstNonSystem = msgs.find((m) => m.role !== 'system');
    assert.notEqual(firstNonSystem?.role, 'tool', '尾部不能以孤立 tool 结果开头');
  });

  it('a second compaction extends the digest instead of rewriting it', async () => {
    const p = new RecordingProvider();
    const a = makeAgent(p);
    fillBulk(a, 14);
    await a.chat('first');
    const d1 = p.sent[p.sent.length - 1].find((m) => /压缩记录/.test(m.content))?.content ?? '';

    // Push well past the trigger again so a second compaction fires.
    fillBulk(a, 14);
    await a.chat('second');
    const d2 = p.sent[p.sent.length - 1].find((m) => /压缩记录/.test(m.content))?.content ?? '';

    assert.notEqual(d1, d2, '第二次压缩应折叠进更多内容');
    // The bulk of the old digest should survive at the FRONT, which is what
    // keeps the cache valid up to the new material.
    const oldBody = d1.slice(d1.indexOf('\n\n') + 2);
    const newBody = d2.slice(d2.indexOf('\n\n') + 2);
    assert.ok(newBody.startsWith(oldBody), '新摘要应以旧摘要开头（可追加），而不是重写');
  });
});
