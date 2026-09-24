/**
 * The session sent to the model is the session on disk.
 *
 * An earlier build replaced history past ~120k characters with an 8k digest.
 * The file kept growing, but the model stopped seeing the early turns, so the
 * usable session length was stuck. These tests pin the opposite: a long
 * transcript is sent in full, later turns only append, and nothing is deleted.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../agent.js';
import type { LLMMessage, StreamChunk, ToolDefinition, LLMProvider } from '@she/shared';

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

function makeAgent(provider: RecordingProvider) {
  const a = new Agent(makeConfig(), { } as never, { definitions: [], execute: async () => '' } as never, null);
  (a as unknown as { provider: LLMProvider }).provider = provider;
  return a;
}

function push(agent: Agent, ...msgs: LLMMessage[]) {
  agent.setHistory([...agent.getHistory(), ...msgs]);
}

function fillBulk(agent: Agent, blocks: number, charsPer = 10_000) {
  for (let i = 0; i < blocks; i++) {
    push(agent,
      { role: 'user', content: `block ${i} ` + 'x'.repeat(charsPer) },
      { role: 'assistant', content: `ack ${i}` },
    );
  }
}

describe('a long session is sent whole', () => {
  it('does not replace early turns with a digest', async () => {
    const p = new RecordingProvider();
    const a = makeAgent(p);
    fillBulk(a, 14);
    await a.chat('hello');
    const last = p.sent[p.sent.length - 1];
    assert.ok(!last.some((m) => /压缩记录/.test(m.content)));
    assert.ok(last.some((m) => m.content.startsWith('block 0 ')), '最早的一轮必须还在请求里');
    assert.ok(last.some((m) => m.content === 'hello'));
  });

  it('a later turn only appends', async () => {
    const p = new RecordingProvider();
    const a = makeAgent(p);
    fillBulk(a, 14);
    await a.chat('one');
    await a.chat('two');
    const prev = p.sent[p.sent.length - 2];
    const next = p.sent[p.sent.length - 1];
    for (let i = 0; i < prev.length; i++) {
      assert.equal(next[i]?.content, prev[i].content, `第 ${i} 条被改写了`);
      assert.equal(next[i]?.role, prev[i].role);
    }
    assert.ok(next.length > prev.length);
  });

  it('stored history keeps growing and keeps the first turn', async () => {
    const p = new RecordingProvider();
    const a = makeAgent(p);
    fillBulk(a, 14);
    const before = a.getHistory().length;
    await a.chat('hello');
    const after = a.getHistory();
    assert.ok(after.length > before);
    assert.ok(after.some((m) => m.content.startsWith('block 0 ')));
  });
});
