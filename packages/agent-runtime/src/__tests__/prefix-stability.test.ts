/**
 * Byte-stable request prefix across agent rebuilds and restarts.
 *
 * An agent is rebuilt far more often than a session changes (settings saves, model switches, MCP
 * and plugin reloads, a server restart). Each rebuild used to re-read rules and skills and recompute
 * the calibration block, so a resumed session could send a different system message and pay full
 * price for its whole history. These tests pin:
 *
 *   - the first system message a session sends is recorded and reused verbatim by later agents;
 *   - a brand-new session gets exactly what it got before (no record, nothing reused);
 *   - the stuck-loop nudge is part of history, so the next turn's request carries the same bytes;
 *   - every model request leaves a `request` event with its tokens and a prefix hash.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../agent.js';
import type { LLMMessage, StreamChunk, ToolDefinition, LLMProvider } from '@she/shared';

const NUDGE_PREFIX = '[\u7cfb\u7edf\u63d0\u793a]';
const BLOCK = /Self-Review \u2014 Your Calibration/;

class RecordingProvider implements LLMProvider {
  name = 'stub';
  sent: LLMMessage[][] = [];
  tools: ToolDefinition[][] = [];
  private n = 0;
  constructor(private script?: (messages: LLMMessage[], n: number) => LLMMessage) {}

  async chat(messages: LLMMessage[], tools?: ToolDefinition[], onChunk?: (c: StreamChunk) => void): Promise<LLMMessage> {
    this.sent.push(messages.map((m) => ({ ...m })));
    this.tools.push(tools ?? []);
    onChunk?.({
      type: 'usage',
      usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, cache_hit_tokens: 64, cache_miss_tokens: 36, reasoning_tokens: 5 },
    });
    this.n += 1;
    return this.script ? this.script(messages, this.n) : { role: 'assistant', content: 'ok' };
  }
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-prefix-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function makeConfig(over: Record<string, unknown> = {}) {
  return {
    llm: { provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k', maxTokens: 100, temperature: 0, thinkingLevel: 'low' },
    workspace: { root: dir },
    kb: { dbPath: join(dir, 'kb.sqlite'), maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100, boostOnAccess: 1.5, pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 } },
    skills: { profile: 'dev' },
    automationMode: true,
    server: { port: 0, host: '127.0.0.1' },
    sandbox: { shell: 'auto', timeout: 1000, maxOutputBytes: 1000, denyDestructiveByDefault: true, allowAllCommands: true },
    ...over,
  } as never;
}

const PROBE: ToolDefinition = {
  name: 'probe',
  description: 'Returns the same text every time.',
  parameters: { type: 'object', properties: {} },
} as ToolDefinition;

function makeAgent(provider: RecordingProvider, sessionId: string | null, over: Record<string, unknown> = {}) {
  const a = new Agent(
    makeConfig(over),
    {} as never,
    { definitions: [PROBE], execute: async () => 'same output' } as never,
    sessionId,
  );
  (a as unknown as { provider: LLMProvider }).provider = provider;
  return a;
}

/** The workspace ledger the calibration block is computed from (see prompt-cache.test.ts). */
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

/** Project rules feed the system prompt, so changing them changes what a FRESH build produces. */
function writeRules(text: string) {
  writeFileSync(join(dir, 'AGENTS.md'), text, 'utf8');
  mkdirSync(join(dir, '.she'), { recursive: true });
  writeFileSync(join(dir, '.she', 'rules.md'), text, 'utf8');
}

const systemOf = (p: RecordingProvider, i: number) => String(p.sent[i][0].content);

function runEvents(sessionId: string): Array<Record<string, unknown>> {
  const runs = join(dir, '.she', 'sessions', sessionId, 'runs');
  return readdirSync(runs)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => readFileSync(join(runs, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}

describe('frozen system message per session', () => {
  it('a rebuilt agent (or a restart) sends the same system message bytes, whatever changed meanwhile', async () => {
    writeLedger(4);
    writeRules('Rule set A.');
    const p1 = new RecordingProvider();
    await makeAgent(p1, 'sess-a').chat('one');
    const first = systemOf(p1, 0);
    assert.match(first, BLOCK, 'precondition: the calibration block is part of the message');
    assert.ok(existsSync(join(dir, '.she', 'sessions', 'sess-a', 'system-message.json')), 'the message is recorded');

    // Evidence and rules change between the two agents, so a fresh build would differ ...
    writeLedger(20, 0.6);
    writeRules('Rule set B, quite different.');
    const control = makeAgent(new RecordingProvider(), null).getSystemPromptText();
    assert.notEqual(control, first, 'precondition: a fresh build now produces a different message');

    // ... but the session's next agent sends what the session has been sending.
    const p2 = new RecordingProvider();
    const rebuilt = makeAgent(p2, 'sess-a');
    assert.equal(rebuilt.getSystemPromptText(), first);
    await rebuilt.chat('two');
    assert.equal(systemOf(p2, 0), first, 'rebuild changed the head of the cache prefix');
    // And again: the record is stable, not drifting by one rebuild each time.
    const p3 = new RecordingProvider();
    await makeAgent(p3, 'sess-a').chat('three');
    assert.equal(systemOf(p3, 0), first);
  });

  it('a new session gets exactly what it got before (nothing is reused across sessions)', async () => {
    writeLedger(4);
    writeRules('Rule set A.');
    await makeAgent(new RecordingProvider(), 'sess-old').chat('one');
    writeRules('Rule set B.');
    writeLedger(12, 0.7);
    const expected = makeAgent(new RecordingProvider(), null).getSystemPromptText();
    const p = new RecordingProvider();
    const fresh = makeAgent(p, 'sess-new');
    assert.equal(fresh.getSystemPromptText(), expected);
    await fresh.chat('hi');
    assert.equal(systemOf(p, 0), expected);
  });

  it('a record made under another mode is not reused', async () => {
    const p1 = new RecordingProvider();
    await makeAgent(p1, 'sess-mode').chat('one');
    const manual = makeAgent(new RecordingProvider(), null, { automationMode: false }).getSystemPromptText();
    assert.notEqual(manual, systemOf(p1, 0), 'precondition: the two modes have different prompts');
    const p2 = new RecordingProvider();
    await makeAgent(p2, 'sess-mode', { automationMode: false }).chat('two');
    assert.equal(systemOf(p2, 0), manual);
  });

  it('an empty recorded block still allows the one "no evidence -> evidence" change, then freezes', async () => {
    const p1 = new RecordingProvider();
    await makeAgent(p1, 'sess-late').chat('one');
    assert.doesNotMatch(systemOf(p1, 0), BLOCK);

    writeLedger(4);
    const p2 = new RecordingProvider();
    await makeAgent(p2, 'sess-late').chat('two');
    const withBlock = systemOf(p2, 0);
    assert.match(withBlock, BLOCK);
    assert.ok(withBlock.startsWith(systemOf(p1, 0)), 'the prompt part is the recorded one');

    writeLedger(30, 0.5);
    const p3 = new RecordingProvider();
    await makeAgent(p3, 'sess-late').chat('three');
    assert.equal(systemOf(p3, 0), withBlock);
  });

  it('the tool table is identical across rebuilds', () => {
    const a = makeAgent(new RecordingProvider(), 'sess-tools');
    const b = makeAgent(new RecordingProvider(), 'sess-tools');
    assert.equal(JSON.stringify(b.getToolDefinitions()), JSON.stringify(a.getToolDefinitions()));
  });
});

describe('stuck-loop nudge is persisted', () => {
  it('lands in history after the tool results, and the next turn re-sends the same bytes', async () => {
    let id = 0;
    const p = new RecordingProvider((messages) => {
      const nudged = messages.some((m) => m.role === 'user' && String(m.content).startsWith(NUDGE_PREFIX));
      if (nudged) return { role: 'assistant', content: 'changed approach' };
      return { role: 'assistant', content: '', tool_calls: [{ id: `c${++id}`, type: 'function', function: { name: 'probe', arguments: '{}' } }] } as LLMMessage;
    });
    const a = makeAgent(p, 'sess-stuck');
    await a.chat('go');

    const history = a.getHistory();
    const at = history.findIndex((m) => m.role === 'user' && String(m.content).startsWith(NUDGE_PREFIX));
    assert.ok(at > 0, 'the nudge is in history');
    assert.equal(history[at - 1].role, 'tool', 'it follows the tool result it is about');

    const lastOfTurn = p.sent[p.sent.length - 1];
    assert.equal(String(lastOfTurn[lastOfTurn.length - 1].content).startsWith(NUDGE_PREFIX), true);

    await a.chat('next');
    const nextTurn = p.sent[p.sent.length - 1];
    assert.equal(
      JSON.stringify(nextTurn.slice(0, lastOfTurn.length)),
      JSON.stringify(lastOfTurn),
      'the next turn must extend the previous request, not diverge where the nudge was',
    );
  });
});

describe('per-request usage events', () => {
  it('each model request writes tokens and a prefix hash; `end` carries reasoning_tokens', async () => {
    const p = new RecordingProvider();
    const a = makeAgent(p, 'sess-usage');
    await a.chat('one');
    await a.chat('two');

    const events = runEvents('sess-usage');
    const requests = events.filter((e) => e.kind === 'request');
    assert.equal(requests.length, 2);
    for (const r of requests) {
      assert.deepEqual(r.tokens, { prompt: 100, cache_hit: 64, cache_miss: 36, completion: 7, reasoning: 5 });
      assert.match(String(r.prefix), /^[0-9a-f]{12}$/);
    }
    assert.equal(requests[0].prefix, requests[1].prefix, 'same session, same prefix head');

    const ends = events.filter((e) => e.kind === 'end');
    assert.equal(ends.length, 2);
    assert.equal((ends[0].usage as { reasoning_tokens?: number }).reasoning_tokens, 5);

    // A rebuilt agent for the same session hashes to the same value.
    const p2 = new RecordingProvider();
    await makeAgent(p2, 'sess-usage').chat('three');
    const after = runEvents('sess-usage').filter((e) => e.kind === 'request');
    assert.equal(after[after.length - 1].prefix, requests[0].prefix);
  });
});