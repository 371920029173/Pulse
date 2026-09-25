import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { RunTraceStore, distinctTokens } from '../run-trace.js';
import type { RunEvent } from '../run-trace.js';
import { Agent } from '../agent.js';
import { PendingPatchStore } from '@she/sandbox';
import type { LLMMessage, StreamChunk, ToolDefinition, LLMProvider } from '@she/shared';

/**
 * Run traces: what a turn did, readable afterwards — offline, no model.
 *
 * The store exists because every other record of a turn is gone when the turn ends: the chunks
 * were a UI protocol, the transcript holds messages rather than steps, and the metrics are
 * counters that cannot say which command produced which output. So these assertions are about the
 * properties that make the file usable LATER:
 *
 *   1. a finished run can be re-read and folded into a summary that agrees with its events;
 *   2. a run that DIED is still readable, and its damage is reported rather than smoothed over;
 *   3. a second copy of a credential is not left on disk in the workspace;
 *   4. a claim about evidence can be checked against what actually ran — which is the bridge to
 *      the delivery template, and the only reason `corroborate` exists.
 *
 * The properties that fail silently are the ones worth asserting: a trace that quietly stopped
 * recording looks exactly like a quiet turn.
 */

const dir = () => mkdtempSync(join(tmpdir(), 'she-runs-'));
const plain = (s: string) => s.replace(/\\/g, '/');

describe('RunTraceStore — one file per run', () => {
  it('writes a run that reads back with all its events in order', () => {
    const root = dir();
    const store = new RunTraceStore(root);
    const rec = store.begin({ prompt: '跑一下测试', sessionId: 's1', model: 'm1', tools: ['shell', 'fs_read'] });
    rec.tool({ name: 'shell', args: '{"cmd":"pnpm test"}', result: 'exit code: 0', ms: 1200, ok: true });
    rec.step('准备收尾');
    rec.end({ ok: true, durationMs: 3000, usage: { total_tokens: 42 } });

    const list = store.list();
    assert.equal(list.length, 1);
    const read = store.read(list[0].id);
    assert.ok(read);
    const kinds = read!.events.map((e) => e.kind);
    assert.deepEqual(kinds, ['start', 'tool', 'step', 'end']);
    assert.equal(read!.skipped, 0);
  });

  it('keeps seq strictly increasing across a restart', () => {
    const root = dir();
    const rec = new RunTraceStore(root).begin({ prompt: 'a' });
    rec.tool({ name: 'shell', result: 'ok', ok: true });

    // A new store object over the same directory: the counter is per-run, so what must hold is
    // that the events of one run are numbered 1..n without gaps.
    const id = new RunTraceStore(root).list()[0].id;
    const read = new RunTraceStore(root).read(id)!;
    const seqs = read.events.map((e) => e.seq);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  });

  it('names files so lexical order is chronological, even within one millisecond', () => {
    const root = dir();
    const store = new RunTraceStore(root);
    // No awaits between them, so several land in the same millisecond. The name is what decides
    // the order, so the name has to be strictly increasing rather than merely time-based — this is
    // also what keeps the list ordered when the wall clock steps backwards.
    const prompts: string[] = [];
    for (let i = 0; i < 6; i++) {
      prompts.push(`第 ${i} 轮`);
      store.begin({ prompt: `第 ${i} 轮` }).end({ ok: true });
    }
    const names = readdirSync(join(root, '.she', 'runs')).filter((f) => f.endsWith('.jsonl'));
    assert.equal(names.length, 6);
    const newestFirst = store.list().map((r) => r.prompt);
    assert.deepEqual(newestFirst, prompts.slice().reverse(), `实际顺序 ${newestFirst.join(', ')}`);
  });

  it('does not go backwards when the clock does', () => {
    const root = dir();
    const store = new RunTraceStore(root);
    store.begin({ prompt: '早' }).end({ ok: true });
    const realNow = Date.now;
    try {
      // A clock correction or a laptop waking can move the wall clock back.
      Date.now = () => realNow() - 60_000;
      store.begin({ prompt: '晚' }).end({ ok: true });
    } finally {
      Date.now = realNow;
    }
    assert.equal(store.list()[0].prompt, '晚', '时钟回拨后，后开始的一轮仍要排在最前');
  });

  it('filters the list to one conversation', () => {
    const root = dir();
    const store = new RunTraceStore(root);
    store.begin({ prompt: '会话 A 的一轮', sessionId: 'a' }).end({ ok: true });
    store.begin({ prompt: '会话 B 的一轮', sessionId: 'b' }).end({ ok: true });

    assert.equal(store.list({ sessionId: 'a' }).length, 1);
    assert.equal(store.list({ sessionId: 'a' })[0].prompt, '会话 A 的一轮');
    assert.equal(store.list({ sessionId: 'nobody' }).length, 0);
  });

  it('links the previous run of the same conversation, and only the same one', () => {
    const root = dir();
    const store = new RunTraceStore(root);
    store.begin({ prompt: '第一轮', sessionId: 'a' }).end({ ok: true, durationMs: 10 });
    store.begin({ prompt: '另一会话', sessionId: 'b' }).end({ ok: true });

    const rec = store.begin({ prompt: '第二轮', sessionId: 'a' });
    const prev = store.read(rec.id)!.events.find((e) => e.kind === 'previous');
    assert.ok(prev, '第二轮应该带上第一轮的引用');
    assert.equal(prev!.runs?.[0], store.list({ sessionId: 'a' })[1].id);
  });
});

describe('RunTraceStore — folding events into a summary', () => {
  const stateOf = (root: string) => new RunTraceStore(root).list()[0].state;

  it('reports a completed run as done', () => {
    const root = dir();
    new RunTraceStore(root).begin({ prompt: 'x' }).end({ ok: true });
    assert.equal(stateOf(root), 'done');
  });

  it('reports a failed run as failed, with its reason', () => {
    const root = dir();
    const rec = new RunTraceStore(root).begin({ prompt: 'x' });
    rec.error('连不上接口');
    rec.end({ ok: false, reason: 'turn_failed', text: '连不上接口' });
    const run = new RunTraceStore(root).list()[0];
    assert.equal(run.state, 'failed');
    assert.match(run.error ?? '', /连不上接口/);
  });

  it('reports a run stopped at a gate as paused, not finished', () => {
    const root = dir();
    const rec = new RunTraceStore(root).begin({ prompt: 'x' });
    rec.tool({ name: 'shell', result: '{"needs_confirm":{}}', ok: true });
    rec.awaiting('confirm', { ticketId: 't1', tool: 'shell' });
    // No `end`: this is the state a run is left in while a human decides.
    const run = new RunTraceStore(root).list()[0];
    assert.equal(run.state, 'paused');
    assert.equal(run.reason, 'awaiting_confirm');
  });

  it('counts failed tool calls and names the tools used', () => {
    const root = dir();
    const rec = new RunTraceStore(root).begin({ prompt: 'x' });
    rec.tool({ name: 'shell', result: 'boom', ok: false, failure: 'nonzero_exit' });
    rec.tool({ name: 'fs_read', result: 'ok', ok: true });
    rec.tool({ name: 'shell', result: 'ok', ok: true });
    rec.end({ ok: true });
    const run = new RunTraceStore(root).list()[0];
    assert.equal(run.toolCount, 3);
    assert.equal(run.failedTools, 1);
    assert.deepEqual(run.toolNames, ['shell', 'fs_read']);
  });
});

describe('RunTraceStore — secrets, truncation, damage', () => {
  it('redacts credential-looking argument values but keeps the key', () => {
    const root = dir();
    const rec = new RunTraceStore(root).begin({ prompt: 'x' });
    rec.tool({
      name: 'shell',
      args: JSON.stringify({ cmd: 'curl', headers: { Authorization: 'Bearer abc123', 'x-api-key': 'sk-live' } }),
      result: 'ok',
      ok: true,
    });
    const ev = new RunTraceStore(root).read(rec.id)!.events.find((e) => e.kind === 'tool')!;
    assert.ok(!ev.args!.includes('abc123'), '令牌不能落在文件里');
    assert.ok(!ev.args!.includes('sk-live'));
    assert.ok(ev.args!.includes('[redacted]'), '但键要留着，读的人才知道传了什么');
  });

  it('redacts credentials nested inside the arguments, not just at the top level', () => {
    const root = dir();
    const rec = new RunTraceStore(root).begin({ prompt: 'x' });
    rec.tool({
      name: 'http',
      args: JSON.stringify({
        url: 'https://api.example.com',
        headers: { Authorization: 'Bearer abc123', 'x-api-key': 'sk-live' },
        env: [{ name: 'PASSWORD', value: 'hunter2' }],
      }),
      result: 'ok',
      ok: true,
    });
    const ev = new RunTraceStore(root).read(rec.id)!.events.find((e) => e.kind === 'tool')!;
    for (const secret of ['abc123', 'sk-live', 'hunter2']) {
      assert.ok(!ev.args!.includes(secret), `嵌套的凭据也不能落盘：${secret}`);
    }
    // The URL and the key names survive, so the trace still says what the call was.
    assert.ok(ev.args!.includes('api.example.com'));
    assert.ok(ev.args!.includes('Authorization'));
  });

  it('does not put a confirm ticket into the trace file', () => {
    const root = dir();
    const rec = new RunTraceStore(root).begin({ prompt: 'x' });
    rec.tool({
      name: 'shell',
      result: JSON.stringify({ needs_confirm: { ticket_id: 'tkt-secret', summary: 'rm -rf' } }),
      ok: true,
    });
    const ev = new RunTraceStore(root).read(rec.id)!.events.find((e) => e.kind === 'tool')!;
    // The ticket authorises the dangerous call, so a copy in a workspace file is a copy of the key.
    assert.ok(!ev.result!.includes('tkt-secret'), '工单不能出现在轨迹里');
    assert.match(ev.result!, /confirm event/);
    // The ticket is still attributable — via the event that is about it.
    const raw = readFileSync(rec.path(), 'utf8');
    assert.ok(!raw.includes('tkt-secret'));
  });

  it('records the original length when a field is truncated', () => {
    const root = dir();
    const rec = new RunTraceStore(root, { maxField: 300 }).begin({ prompt: 'x' });
    rec.tool({ name: 'shell', result: 'y'.repeat(900), ok: true });
    const ev = new RunTraceStore(root).read(rec.id)!.events.find((e) => e.kind === 'tool')!;
    assert.ok(ev.result!.length < 900);
    // Without `chars`, a cut record reads as a short complete result.
    assert.equal(ev.chars, 900);
  });

  it('counts a half-written line as damage instead of dropping it silently', () => {
    const root = dir();
    const store = new RunTraceStore(root);
    const rec = store.begin({ prompt: '正常一轮' });
    rec.tool({ name: 'shell', result: 'ok', ok: true });
    // Exactly what a process killed mid-append leaves behind.
    appendFileSync(rec.path(), '{"seq":99,"ts":"2026-01-01T00:00:00.000Z","ki', 'utf8');

    const read = store.read(rec.id)!;
    assert.equal(read.skipped, 1);
    assert.equal(read.events.length, 2, '好的事件照常读出');
  });

  it('does not treat a BOM as damage', () => {
    const root = dir();
    const store = new RunTraceStore(root);
    const rec = store.begin({ prompt: 'x' });
    rec.end({ ok: true });
    writeFileSync(rec.path(), '\uFEFF' + readFileSync(rec.path(), 'utf8'), 'utf8');
    const read = store.read(rec.id)!;
    assert.equal(read.skipped, 0);
    assert.equal(read.events.length, 2);
  });

  it('never lets a damaged line outrank the real sequence', () => {
    const root = dir();
    const store = new RunTraceStore(root);
    const rec = store.begin({ prompt: 'x' });
    appendFileSync(rec.path(), '{"seq":9999,"ts":"2026-01-01T00:00:00.000Z","kind":"end","ok":true}\n', 'utf8');
    appendFileSync(rec.path(), '{"seq":', 'utf8');
    const read = store.read(rec.id)!;
    // The damaged line is counted and not parsed; a well-formed impostor on disk IS parsed, which
    // is why the honesty is about what is REPORTED rather than about trusting the file blindly.
    assert.equal(read.skipped, 1);
    assert.equal(read.events[0].kind, 'start');
  });
});

describe('RunTraceStore — retention', () => {
  it('keeps at most `keep` runs and records what it dropped', () => {
    const root = dir();
    const store = new RunTraceStore(root, { keep: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const rec = store.begin({ prompt: `第 ${i} 轮` });
      rec.end({ ok: true });
      ids.push(rec.id);
    }
    const files = readdirSync(join(root, '.she', 'runs')).filter((f) => f.endsWith('.jsonl'));
    assert.ok(files.length <= 3, `实际保留 ${files.length} 个文件`);

    /*
     * The drop has to be visible in a file that SURVIVED, because the dropped files are gone —
     * a prune nobody recorded is indistinguishable from history that never existed.
     */
    const mentions = store.list().flatMap((r) => store.read(r.id)!.events).filter((e) => e.kind === 'prune');
    assert.ok(mentions.length > 0, '清理事件必须留在存活的轨迹里');
    assert.ok(mentions[0].runs && mentions[0].runs.length > 0, '并且要写明删了哪些');
    // The newest run is never the one deleted by its own begin().
    assert.ok(files.some((f) => f.startsWith(ids[ids.length - 1])), '最新的轨迹不能被自己删掉');
  });
});

describe('RunTraceStore — read safety', () => {
  it('returns null for an id that is not a file in the directory', () => {
    const root = dir();
    const store = new RunTraceStore(root);
    store.begin({ prompt: 'x' }).end({ ok: true });
    assert.equal(store.read('run-0000-nope'), null);
  });

  it('cannot be walked out of its directory by an id', () => {
    const root = dir();
    const store = new RunTraceStore(root);
    store.begin({ prompt: 'x' }).end({ ok: true });
    // A URL-supplied id must never name a file outside `.she/runs`.
    assert.equal(store.read('../../../etc/passwd'), null);
    assert.equal(store.read('..\\..\\secret'), null);
    assert.equal(store.read('run-../../secret'), null);
  });

  it('returns an empty list rather than throwing when nothing has run', () => {
    const store = new RunTraceStore(join(dir(), 'never-created'));
    assert.deepEqual(store.list(), []);
    assert.equal(store.read('anything'), null);
  });
});

describe('RunRecorder — events the panel renders', () => {
  it('records a pre-flight record as one readable line', () => {
    const root = dir();
    const rec = new RunTraceStore(root).begin({ prompt: 'x' });
    rec.preflight({
      id: 'pf-1',
      ts: new Date().toISOString(),
      stated_intent: '清理日志',
      actual_goal: '清空 .she/audit.log',
      confidence: 0.6,
      confidenceClamped: true,
      prerequisites: [{ what: '确认没有别的会话在写', ok: false, blocking: true, kind: 'state' }],
      known_errors: [],
      constraints: [],
      clarification_needed: ['是删整个文件还是只截断？'],
      evidence: [],
    } as never);

    const ev = new RunTraceStore(root).read(rec.id)!.events.find((e) => e.kind === 'preflight')!;
    assert.match(ev.text!, /预检 pf-1/);
    assert.match(ev.text!, /字面诉求: 清理日志/);
    assert.match(ev.text!, /阻断项/);
    assert.match(ev.text!, /开工前要问 1 个问题/);
  });

  it('says which tool and ticket a confirmation was waiting on', () => {
    const root = dir();
    const rec = new RunTraceStore(root).begin({ prompt: 'x' });
    rec.awaiting('confirm', { ticketId: 'tk-9', tool: 'shell', summary: '删除目录' });
    const ev = new RunTraceStore(root).read(rec.id)!.events.find((e) => e.kind === 'confirm')!;
    assert.equal(ev.ticket_id, 'tk-9');
    assert.equal(ev.tool, 'shell');
    assert.equal(ev.reason, 'awaiting_confirm');
  });

  it('stops accepting events after end', () => {
    const root = dir();
    const rec = new RunTraceStore(root).begin({ prompt: 'x' });
    rec.end({ ok: true });
    assert.equal(rec.isClosed(), true);
    // A late event after the close would append after `end`, which reads as a run that restarted.
    assert.equal(rec.tool({ name: 'shell', result: 'late', ok: true }), null);
  });
});

describe('corroborate — is this evidence backed by what actually ran', () => {
  const storeWith = (fn: (s: RunTraceStore) => void) => {
    const root = dir();
    const store = new RunTraceStore(root);
    fn(store);
    return store;
  };

  it('refuses evidence that names a tool this conversation never ran', () => {
    const store = storeWith((s) => {
      const r = s.begin({ prompt: '读文件', sessionId: 'a' });
      r.tool({ name: 'fs_read', args: '{"path":"a.ts"}', result: 'const x = 1', ok: true });
      r.end({ ok: true });
    });
    // The failure mode that matters: evidence invented wholesale.
    const v = store.corroborate('a', 'shell: pnpm test → 12 passed');
    assert.equal(v.backed, false);
    assert.match(v.reason, /没有调用过 `shell`/);
  });

  it('backs a line whose content appears in the run', () => {
    const store = storeWith((s) => {
      const r = s.begin({ prompt: '跑测试', sessionId: 'a' });
      r.tool({ name: 'shell', args: '{"cmd":"pnpm test"}', result: 'exit code: 0\nfixtures/alpha.test.ts', ok: true });
      r.end({ ok: true });
    });
    const v = store.corroborate('a', 'shell: pnpm test → baseline-risky-token 通过');
    // `pnpm test` is in the recorded arguments, so the line is backed as a real call, not as an
    // accurate quote — the check's job is to catch invention, not to verify wording.
    assert.equal(v.backed, true);
  });

  it('reports no runs at all rather than claiming support', () => {
    const store = storeWith((s) => {
      s.begin({ prompt: 'x', sessionId: 'a' }).end({ ok: true });
    });
    const v = store.corroborate('other-session', 'shell: ls');
    assert.equal(v.backed, false);
    assert.match(v.reason, /还没有运行轨迹/);
  });

  it('refuses a line with nothing checkable in it', () => {
    const store = storeWith((s) => {
      const r = s.begin({ prompt: 'x', sessionId: 'a' });
      r.tool({ name: 'shell', result: 'ok', ok: true });
      r.end({ ok: true });
    });
    const v = store.corroborate('a', '完成');
    assert.equal(v.backed, false);
    assert.match(v.reason, /没有可核对的内容/);
  });

  it('finds distinctive tokens, not the words every trace contains', () => {
    const toks = distinctTokens('exit code: 0, tests passed for fixtures/alpha.test.ts');
    assert.ok(toks.includes('fixtures/alpha.test.ts'), `实际 ${toks.join(',')}`);
    assert.ok(!toks.includes('exit'));
    assert.ok(!toks.includes('code'));
    assert.ok(!toks.includes('tests'));
  });
});

describe('summarise — the shape the panel reads', () => {
  it('fills the fields the UI relies on even when the run never started', () => {
    const root = dir();
    mkdirSync(join(root, '.she', 'runs'), { recursive: true });
    const events: RunEvent[] = [];
    void events;
    // A file with no `start` (only possible if a future writer changes the first event) must still
    // fold into something renderable rather than throwing.
    writeFileSync(join(root, '.she', 'runs', 'run-x.jsonl'), '{"seq":1,"ts":"2026-01-01T00:00:00.000Z","kind":"end","ok":true}\n', 'utf8');
    const list = new RunTraceStore(root).list();
    assert.equal(list.length, 1);
    assert.equal(list[0].state, 'done');
    assert.equal(list[0].prompt, '');
    assert.equal(list[0].agent, 'main');
  });
});

describe('run files are plain JSONL a human can read', () => {
  it('writes one JSON object per line, newline terminated', () => {
    const root = dir();
    const rec = new RunTraceStore(root).begin({ prompt: '一个多行\n提问' });
    rec.end({ ok: true });
    const raw = readFileSync(rec.path(), 'utf8');
    assert.ok(raw.endsWith('\n'), '追加式写入必须以换行结束，否则半行会粘在下一行上');
    const lines = raw.trim().split('\n');
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    // A newline inside the prompt must be escaped, not written raw, or the file stops being JSONL.
    assert.ok(!raw.split('\n')[0].includes('一个多行\n'), '换行要被转义');
  });

  it('lives under .she/runs of the workspace it was given', () => {
    const root = dir();
    const store = new RunTraceStore(root);
    assert.equal(plain(store.directory()), plain(join(root, '.she', 'runs')));
  });
});

/**
 * The agent end of the store.
 *
 * These are the assertions the store's own tests cannot make: whether the AGENT actually writes
 * during a real turn, and whether a run survives the continuations that are not a new turn. The
 * batch-apply case is the one worth pinning — it applies several patches through several separate
 * `withTurn` scopes, and the natural implementation closes the trace after the first one, leaving a
 * file that looks like a run which died.
 */
describe('Agent writes the trace, including across continuations', () => {
  const cfgFor = (root: string) => ({
    llm: { provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k', maxTokens: 100, temperature: 0, thinkingLevel: 'low' },
    workspace: { root },
    kb: {
      dbPath: join(root, '.she', 'kb.sqlite'),
      maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100, boostOnAccess: 1.5,
      pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
    },
    skills: { profile: 'dev' },
    automationMode: true,
    server: { port: 0, host: '127.0.0.1' },
    sandbox: { shell: 'auto', timeout: 1000, maxOutputBytes: 1000, denyDestructiveByDefault: true, allowAllCommands: true },
    schedule: { enabled: false, tickSeconds: 30, workingWindow: null },
  });

  /** A provider that returns a fixed sequence of tool calls and then stops. */
  class ScriptedProvider implements LLMProvider {
    name = 'scripted';
    private step = 0;
    constructor(private readonly scripts: Array<Array<{ name: string; args: unknown }>>) {}
    async chat(): Promise<LLMMessage> {
      const calls = this.scripts[this.step];
      if (!calls) return { role: 'assistant', content: 'done' };
      this.step++;
      return {
        role: 'assistant',
        content: '',
        tool_calls: calls.map((c, i) => ({
          id: `call_${this.step}_${i}`,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      };
    }
  }

  const noTools: ToolDefinition[] = [];

  function makeAgent(root: string, provider: LLMProvider, tools?: { defs: ToolDefinition[]; execute: (n: string, a: Record<string, unknown>) => Promise<string> }) {
    const agent = new Agent(
      cfgFor(root) as never,
      {} as never,
      { definitions: tools?.defs ?? noTools, execute: tools?.execute ?? (async () => 'ok') } as never,
      'sess-trace',
    );
    (agent as unknown as { provider: LLMProvider }).provider = provider;
    return agent;
  }

  it('records a turn end to end, with the answer and the reason on the closing event', async () => {
    const root = dir();
    const agent = makeAgent(root, new ScriptedProvider([]));
    await agent.chat('你好', () => { /* chunks unused here */ });

    const store = agent.getRunTraceStore();
    const runs = store.list();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].state, 'done');
    assert.equal(runs[0].prompt, '你好');
    assert.equal(runs[0].session_id, 'sess-trace');
    const events = store.read(runs[0].id)!.events;
    assert.equal(events[0].kind, 'start');
    assert.equal(events[events.length - 1].kind, 'end');
    assert.equal(events[events.length - 1].ok, true);
  });

  it('leaves the run PAUSED, not finished, when a turn stages patches', async () => {
    const root = dir();
    const patches = new PendingPatchStore(root);
    const tools = {
      defs: [{
        name: 'edit',
        description: 'stages an edit for review',
        parameters: { type: 'object', properties: {}, required: [] },
      }] as ToolDefinition[],
      execute: async (): Promise<string> => {
        const staged = ['a.txt', 'b.txt', 'c.txt'].map((name) => patches.stage(name, 'before\n', 'after\n'));
        return JSON.stringify({ needs_apply: staged[staged.length - 1] });
      },
    };
    const agent = makeAgent(root, new ScriptedProvider([[{ name: 'edit', args: {} }]]), tools);

    await agent.chat('改三个文件', () => { /* chunks unused here */ });

    const store = agent.getRunTraceStore();
    const runs = store.list();
    assert.equal(runs.length, 1);
    // No `end` yet: a person has not decided. Recording this as finished is what would make the
    // most interesting run — the one that needed approval — indistinguishable from a quiet one.
    assert.equal(runs[0].state, 'paused', JSON.stringify(runs[0]));
    assert.equal(runs[0].reason, 'awaiting_apply');
    assert.ok(store.read(runs[0].id)!.events.some((e) => e.kind === 'apply'), '要写明停在等应用补丁');
  });

  it('keeps ONE trace across a batch of patch applications, and closes it once', async () => {
    const root = dir();
    const patches = new PendingPatchStore(root);
    const tools = {
      defs: [{
        name: 'edit',
        description: 'stages an edit for review',
        parameters: { type: 'object', properties: {}, required: [] },
      }] as ToolDefinition[],
      execute: async (): Promise<string> => {
        const staged = ['a.txt', 'b.txt', 'c.txt'].map((name) => patches.stage(name, 'before\n', 'after\n'));
        return JSON.stringify({ needs_apply: staged[staged.length - 1] });
      },
    };
    const agent = makeAgent(root, new ScriptedProvider([[{ name: 'edit', args: {} }]]), tools);
    await agent.chat('改三个文件', () => { /* chunks unused here */ });

    await agent.applyAllPatches();

    const store = agent.getRunTraceStore();
    const runs = store.list();
    // Three patches go through three separate `withTurn` scopes. A trace that stopped after the
    // first would either be a second file or a run left open — both are a lie about what happened.
    assert.equal(runs.length, 1, `补丁批应用应该是同一条轨迹，实际 ${runs.length} 条`);
    const events = store.read(runs[0].id)!.events;
    const applied = events.filter((e) => e.kind === 'step' && /已应用补丁/.test(e.text ?? ''));
    assert.equal(applied.length, 3, `三次应用都要在轨迹里：${JSON.stringify(events.map((e) => e.text))}`);
    assert.equal(events.filter((e) => e.kind === 'end').length, 1, '只应有一次收尾');
    assert.equal(runs[0].state, 'done');
  });
});

