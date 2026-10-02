/**
 * The system message is the head of the provider's cache prefix, so anything inside it that is
 * rebuilt per turn is billed again on every turn — for the whole request, not just for itself.
 *
 * Measured against the real endpoint (deepseek-flash, 2026-10-03, ~19.5k-char history, the block in
 * the system message):
 *
 *   block unchanged between two turns → 94% of the request served from the provider's cache
 *   block recomputed between two turns → 37%
 *
 * The block in question is the calibration self-review reading (`calibrationBlock`), and it used to be
 * rebuilt every turn exactly like that. These tests pin the fix: built until it has something to
 * say, then frozen for the lifetime of the agent.
 *
 * `docs/context-and-caching.md` states the rule ("每轮重新生成摘要 = 每轮改前缀") for the compaction
 * summary; this is the same rule applied to the other block that lives in the prefix.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-cacheprefix-')); });
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

function makeAgent(provider: RecordingProvider, sessionId: string | null = null) {
  const a = new Agent(
    makeConfig(),
    {} as never,
    { definitions: [], execute: async () => '' } as never,
    sessionId,
  );
  (a as unknown as { provider: LLMProvider }).provider = provider;
  return a;
}

/**
 * Write the workspace ledger (numbers only) that the verdict is computed from.
 *
 * `samples` of over-claimed-but-failed runs: confidence 0.9 against a 1-in-4 success rate, which is
 * a 0.65 bias — well past the 0.25 threshold that turns `unknown` into `overconfident`.
 */
function writeLedger(count: number, claimed = 0.9) {
  mkdirSync(join(dir, '.she', 'reflection'), { recursive: true });
  const samples = Array.from({ length: count }, (_, i) => ({
    at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    claimed,
    attempted: 4,
    succeeded: 1,
  }));
  writeFileSync(join(dir, '.she', 'reflection', 'confidence.json'), JSON.stringify({ samples }), 'utf8');
}

/** Write this conversation's own samples, which carry topics (the per-topic half of the block). */
function writeSessionSamples(sessionId: string, topics: string[]) {
  const dirPath = join(dir, '.she', 'sessions', sessionId);
  mkdirSync(dirPath, { recursive: true });
  const samples = topics.map((topic, i) => ({
    at: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString(),
    claimed: 0.9,
    attempted: 4,
    succeeded: 1,
    topic,
  }));
  writeFileSync(join(dirPath, 'confidence.json'), JSON.stringify({ samples }), 'utf8');
}

const systemOf = (p: RecordingProvider, turn: number) => String(p.sent[turn][0].content);

describe('a per-turn block does not sit in the cache prefix', () => {
  it('once the self-review block says something, it never changes again in that session', async () => {
    const p = new RecordingProvider();
    const a = makeAgent(p, 'sess-cache');

    // Turn 1: nothing measured yet, so no block — and the prefix must stay that way rather than
    // gaining one later in the same session.
    await a.chat('one');
    assert.ok(!/Self-Review — Your Calibration/.test(systemOf(p, 0)), '没有证据时不该有自评块');

    // The evidence arrives between turns. This is the one transition allowed: empty → non-empty.
    writeLedger(4);
    await a.chat('two');
    const firstWithBlock = systemOf(p, 1);
    assert.match(firstWithBlock, /Self-Review — Your Calibration/, '有证据之后就该带上自评块');

    // More evidence, and DIFFERENT evidence, on every later turn. The block must not follow it:
    // following it is what cost 57% of the request per turn.
    for (const [turn, count] of [2, 3, 4, 5].map((t, i) => [t, 6 + i * 3])) {
      writeLedger(count as number, 0.7 + (turn as number) / 100);
      await a.chat(`turn ${turn}`);
      assert.equal(
        systemOf(p, turn as number),
        firstWithBlock,
        `第 ${turn} 轮的系统消息变了 —— 它一变，系统消息之后的整个历史与工具表都按全价重算`,
      );
    }
  });

  it('a session that starts with evidence carries the block from its first request', async () => {
    writeLedger(4);
    const p = new RecordingProvider();
    const a = makeAgent(p, 'sess-warm');
    await a.chat('one');
    const first = systemOf(p, 0);
    assert.match(first, /Self-Review — Your Calibration/, '起始就有证据时，第一条请求就该带上');

    writeLedger(20, 0.95);
    await a.chat('two');
    assert.equal(systemOf(p, 1), first, '冻结之后不再随证据变化');
  });

  it('the per-topic half of the block cannot change it either', async () => {
    writeLedger(4);
    writeSessionSamples('sess-topics', ['检索', '检索', '检索']);
    const p = new RecordingProvider();
    const a = makeAgent(p, 'sess-topics');
    await a.chat('one');
    const first = systemOf(p, 0);
    assert.match(first, /偏差最大的领域/, '本会话有足够的领域样本时，块里要带上领域名');

    // A different set of topics for the same conversation — the session half changed, the frozen
    // block must not.
    writeSessionSamples('sess-topics', ['排版', '排版', '排版']);
    await a.chat('two');
    assert.equal(systemOf(p, 1), first, '领域列表变了也不该改前缀');
    assert.match(first, /检索/, '（对照组：确认第一轮记下的确实是旧的领域列表）');
  });

  it('all three request builders send the same system message', async () => {
    writeLedger(4);
    const p = new RecordingProvider();
    const a = makeAgent(p, 'sess-builders');
    await a.chat('one');
    const sent = systemOf(p, 0);

    // The confirm/patch continuations build their own request. Same run, same instructions — the
    // two used to send the bare prompt, which is both a cache miss at the boundary and a different
    // instruction set inside one run.
    const composed = (a as unknown as { systemMessageContent(): string }).systemMessageContent();
    assert.equal(composed, sent, '系统消息必须只有一处拼装，且三种请求拿到同一份');
  });
});
