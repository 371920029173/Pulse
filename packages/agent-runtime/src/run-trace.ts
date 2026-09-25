/**
 * Run traces: one JSONL file per turn, so a run can be opened AGAIN afterwards.
 *
 * The gap this closes is narrow and specific. Everything about a turn already exists somewhere,
 * but only DURING the turn: the streamed bubbles are gone when the tab reloads, the transcript
 * holds messages rather than steps, and the metrics endpoint aggregates counters that cannot say
 * which command produced which output. So "what did it actually do, in what order, and did each
 * step work" had no answer a person could go and read.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS RECORDED BY THE AGENT AND NOT FROM `StreamChunk`
 *
 * Writing the chunk stream to disk is the obvious implementation, and it is the wrong one:
 *
 *   - a chunk carries a tool call's ARGUMENTS only in `tool_call_end`, and its OUTPUT in a
 *     separate `tool_result` minutes later. A reader would have to re-join them, which is the
 *     work this file exists to do once.
 *   - `stream: false` produces NO chunks at all, so an entire class of turn would silently have
 *     no trace — and its absence would look identical to a run where nothing happened.
 *   - chunks are a UI protocol. Their shape changes for the UI's sake, and the trace would then
 *     change with it.
 *
 * The agent, at the point it runs a tool, has the name, the arguments, the result, the duration
 * and whether the classifier called it a failure — all in one scope. Recording there costs a few
 * lines and makes the file a faithful record rather than a reconstruction.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OTHER DECISIONS
 *
 * **JSONL, appended.** Same reasoning as `.she/audit.log`: the case where a trace matters most is
 * the run that DIED, so a half-written file has to still be readable. One `appendFileSync` per
 * event, nothing rewritten.
 *
 * **Steps, not tokens.** Text and reasoning deltas are per-token; storing them would produce a
 * file larger than the transcript that nobody would read. What is stored is the step boundary:
 * which tool ran with what arguments, what came back, how long it took. The final answer is
 * stored once, as the last event.
 *
 * **Secrets are redacted, sizes are capped, and the cap says so.** Tool arguments are a common
 * place for an API key to appear (`curl -H "Authorization: ..."`), and this is a SECOND copy of
 * them on disk. Values under a key that looks like a credential are replaced, and a truncated
 * field records its original length so a cut record cannot be read as a short complete one.
 *
 * **Retention is bounded, and the drop is recorded.** Files are pruned to the newest `keep`, and
 * the run that triggered the prune carries a `prune` event naming what went. Quietly losing
 * history is the failure mode this whole family of stores exists to avoid.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PreflightRecord } from './preflight.js';

/** How a run ended, as far as its own events can tell. */
export type RunState = 'running' | 'paused' | 'done' | 'failed';

export type RunEventKind =
  /** The turn began: what was asked, in which conversation, on which model, with which tools. */
  | 'start'
  /** The previous run in this conversation, so the chain is visible without cross-referencing. */
  | 'previous'
  /** The pre-flight analysis this run was opened with, if there was one. */
  | 'preflight'
  /** The agent's own narration (the `status` chunks: fallback used, loop detected, …). */
  | 'step'
  /** One finished tool call: name, arguments, duration, outcome, output excerpt. */
  | 'tool'
  /** The turn stopped and is waiting for a human to approve a ticket. */
  | 'confirm'
  /** The turn stopped and is waiting for a human to apply a staged patch. */
  | 'apply'
  /** Starting this run deleted older runs to stay within the cap; names what went. */
  | 'prune'
  /** The turn failed: what the error was. */
  | 'error'
  /** The turn finished. `ok` says whether it produced an answer. */
  | 'end';

export interface RunEvent {
  seq: number;
  ts: string;
  kind: RunEventKind;
  /** `start`: the user's message (first line). `step`/`end`/`error`: the text. */
  text?: string;
  /** Original length, present only when a text field was truncated. */
  chars?: number;
  /** `start`: which conversation, which model, and who is running (main or a delegated child). */
  session_id?: string;
  model?: string;
  agent?: 'main' | 'subagent';
  /** `start`: the automation mode in force, so a run stopping to ask can be explained. */
  mode?: string;
  /** `start`: the tool names this agent was given, so "it never had that tool" is checkable. */
  tools?: string[];
  /** `tool` */
  tool?: string;
  args?: string;
  result?: string;
  ms?: number;
  ok?: boolean;
  /** `tool`: the classifier's verdict kind, when the call failed. */
  failure?: string;
  /** `confirm` / `apply` */
  ticket_id?: string;
  path?: string;
  /** `end` */
  durationMs?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  /** `previous` / `preflight` / `prune`: the runs or records being referred to. */
  runs?: string[];
  /** `error`, or `end` on a run that stopped short: why. */
  reason?: string;
}

/** What a reader sees in the list, folded from the events. */
export interface RunSummary {
  id: string;
  session_id?: string;
  /** `main` or `subagent` — who did this work. */
  agent: 'main' | 'subagent';
  model?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  state: RunState;
  /** First line of what was asked. */
  prompt: string;
  toolCount: number;
  failedTools: number;
  toolNames: string[];
  steps: number;
  error?: string;
  /** Reasons the run stopped short: `awaiting_confirm`, `turn_in_progress`, `aborted`, … */
  reason?: string;
}

export interface RunReadResult {
  run: RunSummary;
  events: RunEvent[];
  /** Unparseable lines: a process killed mid-append. Reported, never hidden. */
  skipped: number;
}

export interface RunTraceOptions {
  /** Run files kept on disk. Beyond this the oldest are deleted, and the drop is recorded. */
  keep?: number;
  /** Longest `text` / `args` / `result` field written; the original length is kept alongside. */
  maxField?: number;
}

const DEFAULT_KEEP = 200;
const DEFAULT_MAX_FIELD = 2000;
const MAX_PROMPT = 400;
/** Argument keys whose VALUE is a credential, matched case-insensitively on the key name. */
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|bearer|cookie)/i;

function cap(value: string, max: number): { text: string; chars?: number } {
  if (value.length <= max) return { text: value };
  return { text: value.slice(0, max), chars: value.length };
}

/**
 * Replace credential-looking values, keeping the key so the reader still sees what was passed.
 *
 * Done on the SERIALISED arguments rather than by walking the parsed object: the arguments reach
 * this point as the model's raw JSON string, and re-parsing a malformed fragment to redact it
 * would either throw inside the agent loop or silently drop the arguments from the trace.
 *
 * Recursive, because the credential is almost never at the top level. An HTTP call passes
 * `{ headers: { Authorization: "Bearer …" } }` and a shell call can pass `{ env: { API_KEY: … } }`;
 * a top-level-only pass would leave both of those in the file while reporting the arguments as
 * redacted — the worst of both outcomes, since the trace would look scrubbed.
 */
function redact(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== 'object') return argsJson;
    return JSON.stringify(redactValue(parsed));
  } catch {
    // Not valid JSON (or not an object): leave it, but a credential cannot be found in prose we
    // cannot parse. Still capped by the caller.
    return argsJson;
  }
}

/** Depth-limited by construction: `JSON.parse` output is acyclic, so recursion terminates. */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key) && typeof v === 'string') out[key] = '[redacted]';
      else out[key] = redactValue(v);
    }
    /*
     * The name/value pair form: `{ name: "API_KEY", value: "sk-…" }`.
     *
     * Common in `env` arrays, where the name is in one field and the secret in another — so the
     * key-based pass above sees no credential-shaped KEY at all and would leave the value in.
     * Recognised by the pair rather than by the value's shape: guessing "looks like a token" would
     * scrub ordinary strings.
     */
    const nameField = typeof out.name === 'string' ? out.name : typeof out.key === 'string' ? out.key : '';
    if (nameField && SECRET_KEY.test(nameField) && typeof out.value === 'string') {
      out.value = '[redacted]';
    }
    return out;
  }
  /*
   * A bare string that itself carries a credential pair.
   *
   * `{"value": "Authorization: Bearer sk-…"}` is a real shape (a header blob, an array of pairs).
   * Scrubbing on a leading `name: value` / `name=value` inside the string catches it without
   * mangling ordinary prose, which almost never begins with one of those names and a separator.
   */
  if (typeof value === 'string') {
    const m = /^\s*([A-Za-z0-9_-]{2,40})\s*[:=]\s*(\S.*)$/s.exec(value);
    if (m && SECRET_KEY.test(m[1])) return `${m[1]}: [redacted]`;
  }
  return value;
}

/**
 * Replace the payload of a confirmation request in a tool's output.
 *
 * The trace is read by the person, not by the model, so this is not the same defence as the
 * redaction in the agent loop — it is about not making a second copy of a bearer credential. A
 * ticket is exactly that: whoever holds it can authorise the dangerous call, and the file sits in
 * the workspace where any tool, plugin or editor can read it. Which ticket was involved is kept
 * on the `confirm` event, where it is attributed and next to the human's decision.
 */
function redactResult(result: string): string {
  if (!result.includes('"needs_confirm"') && !result.includes('"needs_apply"')) return result;
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') {
      if ('needs_confirm' in parsed) parsed.needs_confirm = '[recorded as a confirm event]';
      if ('needs_apply' in parsed) parsed.needs_apply = '[recorded as an apply event]';
      return JSON.stringify(parsed);
    }
  } catch { /* not JSON: nothing identifiable to strip */ }
  return result;
}

/** Fold a run's events into the summary the list and the panel show. */
function summarise(id: string, events: RunEvent[]): RunSummary {
  const start = events.find((e) => e.kind === 'start');
  const summary: RunSummary = {
    id,
    agent: start?.agent === 'subagent' ? 'subagent' : 'main',
    startedAt: start?.ts ?? events[0]?.ts ?? '',
    state: 'running',
    prompt: start?.text ?? '',
    toolCount: 0,
    failedTools: 0,
    toolNames: [],
    steps: events.length,
  };
  if (start?.model) summary.model = start.model;
  if (start?.session_id) summary.session_id = start.session_id;

  for (const e of events) {
    switch (e.kind) {
      case 'tool':
        summary.toolCount++;
        if (e.ok === false) summary.failedTools++;
        if (e.tool && !summary.toolNames.includes(e.tool)) summary.toolNames.push(e.tool);
        break;
      case 'confirm':
        summary.state = 'paused';
        summary.reason = e.reason ?? 'awaiting_confirm';
        break;
      case 'apply':
        summary.state = 'paused';
        summary.reason = e.reason ?? 'awaiting_apply';
        break;
      case 'error':
        summary.state = 'failed';
        summary.error = e.text ?? e.reason;
        break;
      case 'end':
        summary.state = e.ok === false ? 'failed' : 'done';
        summary.endedAt = e.ts;
        summary.durationMs = e.durationMs;
        if (e.reason) summary.reason = e.reason;
        if (e.ok === false && e.text) summary.error = e.text;
        break;
      default:
        break;
    }
  }
  return summary;
}

/**
 * One run being recorded.
 *
 * Holds the sequence counter in memory, so events land in the order they happened rather than the
 * order the filesystem saw them, and caches whether the file is known to exist so the common path
 * is a single append.
 */
export class RunRecorder {
  private seq = 0;
  private closed = false;
  /** Set once the first event is written; `begin` is lazy so a turn that never runs leaves nothing. */
  private opened = false;

  constructor(
    private file: string,
    private maxField: number,
    public readonly id: string,
    private keep: number,
  ) {}

  /** Where this run is written. Exposed for the receipt and for tests. */
  path(): string {
    return this.file;
  }

  /**
   * Append one event. Returns the event so a caller can assert on it, and never throws.
   *
   * A trace that can break the work it is tracing is worse than no trace: the same stance as
   * `auditSafe` in the server. A disk that is full or locked costs the record, not the turn.
   */
  private write(kind: RunEventKind, fields: Omit<RunEvent, 'seq' | 'ts' | 'kind'>): RunEvent | null {
    if (this.closed) return null;
    const event: RunEvent = { seq: ++this.seq, ts: new Date().toISOString(), kind, ...fields };
    try {
      if (!this.opened) {
        mkdirSync(join(this.file, '..'), { recursive: true });
        this.opened = true;
      }
      appendFileSync(this.file, JSON.stringify(event) + '\n', 'utf8');
    } catch {
      return event;
    }
    return event;
  }

  private capAll(fields: Omit<RunEvent, 'seq' | 'ts' | 'kind'>, limits?: { text?: number }): Omit<RunEvent, 'seq' | 'ts' | 'kind'> {
    const out = { ...fields };
    if (typeof out.text === 'string') {
      const c = cap(out.text, limits?.text ?? this.maxField);
      out.text = c.text;
      if (c.chars !== undefined) out.chars = c.chars;
    }
    if (typeof out.args === 'string') {
      const c = cap(out.args, this.maxField);
      out.args = c.text;
      if (c.chars !== undefined) out.chars = (out.chars ?? 0) + c.chars;
    }
    if (typeof out.result === 'string') {
      const c = cap(out.result, this.maxField);
      out.result = c.text;
      if (c.chars !== undefined) out.chars = (out.chars ?? 0) + c.chars;
    }
    return out;
  }

  /** The turn began. */
  start(info: {
    prompt: string;
    sessionId?: string | null;
    model?: string;
    agent?: 'main' | 'subagent';
    tools?: string[];
    mode?: string;
  }): RunEvent | null {
    return this.write('start', this.capAll({
      text: info.prompt,
      session_id: info.sessionId ?? undefined,
      model: info.model,
      agent: info.agent ?? 'main',
      mode: info.mode,
      tools: info.tools,
    }, { text: MAX_PROMPT }));
  }

  /** What the previous run in this conversation was, so the chain is readable in one file. */
  previous(p: { id: string; state: RunState; endedAt?: string; toolCount: number; error?: string }): RunEvent | null {
    const when = p.endedAt ? p.endedAt.slice(11, 19) : '（未结束）';
    return this.write('previous', this.capAll({
      text: `上一次运行 ${p.id} 于 ${when} 结束：${p.state}，${p.toolCount} 次工具调用`
        + (p.error ? `，最后一次失败：${p.error}` : ''),
      runs: [p.id],
      reason: p.state,
    }));
  }

  /** The pre-flight record this run was opened with, summarised. */
  preflight(rec: PreflightRecord, file?: string): RunEvent | null {
    const blocked = rec.prerequisites.filter((p) => !p.ok && p.blocking);
    const parts = [
      `预检 ${rec.id}（置信度 ${rec.confidence}${rec.confidenceClamped ? '，已被检查结果压到上限' : ''}）`,
      `字面诉求: ${rec.stated_intent}`,
      `实际目标: ${rec.actual_goal}`,
    ];
    if (rec.known_errors.length) parts.push(`错题本命中 ${rec.known_errors.length} 条`);
    if (blocked.length) parts.push(`阻断项: ${blocked.map((p) => p.what).join('；')}`);
    if (rec.clarification_needed.length) parts.push(`开工前要问 ${rec.clarification_needed.length} 个问题`);
    return this.write('preflight', this.capAll({ text: parts.join('\n'), runs: [rec.id, file ?? ''], reason: rec.id }));
  }

  /** The agent narrating what it is doing. Cheap, and often the only explanation of a step. */
  step(text: string): RunEvent | null {
    return this.write('step', this.capAll({ text }));
  }

  /** One finished tool call. */
  tool(info: {
    name: string;
    args?: string;
    result?: string;
    ms?: number;
    ok?: boolean;
    failure?: string;
  }): RunEvent | null {
    return this.write('tool', this.capAll({
      tool: info.name,
      args: info.args === undefined ? undefined : redact(info.args),
      result: info.result === undefined ? undefined : redactResult(info.result),
      ms: info.ms,
      ok: info.ok,
      failure: info.failure,
    }));
  }

  /** The turn stopped to wait for a human. */
  awaiting(kind: 'confirm' | 'apply', info: { ticketId?: string; tool?: string; path?: string; summary?: string }): RunEvent | null {
    return this.write(kind, this.capAll({
      ticket_id: info.ticketId,
      tool: info.tool,
      path: info.path,
      text: info.summary,
      reason: kind === 'confirm' ? 'awaiting_confirm' : 'awaiting_apply',
    }));
  }

  /** Older runs were deleted to stay within the cap. Named, so the loss is measurable. */
  pruned(runs: string[]): RunEvent | null {
    if (!runs.length) return null;
    return this.write('prune', this.capAll({
      runs,
      text: `为保持在 ${this.keep} 个文件以内，删除了 ${runs.length} 份更早的运行轨迹`,
    }));
  }

  /** The turn failed. */
  error(message: string): RunEvent | null {
    return this.write('error', this.capAll({ text: message }));
  }

  /**
   * The turn finished, one way or another. Marks the recorder closed.
   *
   * `reason` distinguishes the endings a reader has to tell apart — a turn that stopped at a
   * confirmation gate is not a turn that failed, and a run closed by an abort is not a run that
   * completed.
   */
  end(info: { ok: boolean; reason?: string; text?: string; durationMs?: number; usage?: RunEvent['usage'] }): RunEvent | null {
    const event = this.write('end', this.capAll({
      ok: info.ok,
      reason: info.reason,
      text: info.text,
      durationMs: info.durationMs,
      usage: info.usage,
    }));
    this.closed = true;
    return event;
  }

  /** Stop accepting events without writing an `end` (used when a run is handed to its continuation). */
  close(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/**
 * The `.she/runs/` directory.
 *
 * One file per turn, named `run-<stamp>-<hex>.jsonl` so lexical order is chronological and two
 * runs starting in the same millisecond cannot collide. Reading is by directory listing rather
 * than by joining a caller-supplied id onto a path — an id that came from a URL must not be able
 * to name a file outside this directory.
 */

/**
 * A clock that never repeats and never goes backwards, used only to NAME files.
 *
 * The name is what decides the order — `files()` sorts on it and never reads a timestamp — so the
 * name has to be strictly increasing. Two problems break that with a plain `Date.now()`:
 *
 *   - two runs can begin inside the same millisecond, and then the random hex suffix decides the
 *     order instead of the clock, so the list is not newest-first;
 *   - the wall clock can step BACKWARDS (NTP correction, a laptop waking, a user changing the
 *     date), which puts a later run before an earlier one — and a trace list with the newest run
 *     buried is a list nobody can trust.
 *
 * Per-process, so two processes writing this directory concurrently can still interleave. That is
 * accepted: they would also be two agents working on one workspace, which the turn lock prevents.
 */
let lastStampMs = 0;
function monotonicStamp(): string {
  const now = Date.now();
  lastStampMs = now > lastStampMs ? now : lastStampMs + 1;
  return new Date(lastStampMs).toISOString().replace(/[:.]/g, '-');
}
export class RunTraceStore {
  private dir: string;
  private keep: number;
  private maxField: number;
  private dirEnsured = false;

  constructor(root: string, opts: RunTraceOptions = {}) {
    this.dir = join(root, '.she', 'runs');
    this.keep = Math.max(1, opts.keep ?? DEFAULT_KEEP);
    this.maxField = Math.max(200, opts.maxField ?? DEFAULT_MAX_FIELD);
  }

  private ensureDir(): void {
    if (this.dirEnsured) return;
    mkdirSync(this.dir, { recursive: true });
    this.dirEnsured = true;
  }

  /** Run files, newest first. `audit.log`-style: the name encodes the order. */
  private files(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.startsWith('run-') && f.endsWith('.jsonl'))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /**
   * Open a run.
   *
   * Also does the housekeeping: prunes to `keep`, and records what the prune cost in the run that
   * caused it. Doing it here rather than on a timer means the cost is attached to the run that
   * paid it, which is the only run whose trace could legitimately mention it.
   */
  begin(info: {
    prompt: string;
    sessionId?: string | null;
    model?: string;
    agent?: 'main' | 'subagent';
    tools?: string[];
    mode?: string;
  }): RunRecorder {
    this.ensureDir();
    const stamp = monotonicStamp();
    const id = `run-${stamp}-${randomUUID().slice(0, 6)}`;
    const recorder = new RunRecorder(join(this.dir, `${id}.jsonl`), this.maxField, id, this.keep);

    /*
     * Prune BEFORE the first event is written, so the new file is already counted and cannot be
     * the one that gets deleted by its own begin().
     */
    const existing = this.files();
    const excess = existing.slice(this.keep - 1);
    const removed: string[] = [];
    for (const f of excess) {
      try {
        rmSync(join(this.dir, f), { force: true });
        removed.push(f.replace(/\.jsonl$/, ''));
      } catch { /* a locked file is not worth failing a turn over */ }
    }

    if (info.agent !== 'subagent') {
      const prev = this.sessionRuns(info.sessionId ?? null, 1).filter((r) => r.id !== id)[0];
      if (prev) {
        recorder.previous({
          id: prev.id,
          state: prev.state,
          endedAt: prev.endedAt,
          toolCount: prev.toolCount,
          error: prev.error,
        });
      }
    }
    recorder.pruned(removed);
    recorder.start(info);
    return recorder;
  }

  /** Every run, newest first, optionally filtered to one conversation. */
  list(opts: { sessionId?: string | null; limit?: number } = {}): RunSummary[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const out: RunSummary[] = [];
    for (const f of this.files()) {
      const parsed = this.parse(f);
      if (!parsed) continue;
      const summary = summarise(f.replace(/\.jsonl$/, ''), parsed.events);
      if (opts.sessionId && summary.session_id !== opts.sessionId) continue;
      out.push(summary);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Runs in one conversation, newest first. */
  sessionRuns(sessionId: string | null, limit = 20): RunSummary[] {
    return this.list({ sessionId: sessionId ?? undefined, limit });
  }

  /** One run in full, or null when the id does not name a file in this directory. */
  read(id: string): RunReadResult | null {
    const file = this.files().find((f) => f === `${id}.jsonl`);
    if (!file) return null;
    const parsed = this.parse(file);
    if (!parsed) return null;
    return {
      run: summarise(id, parsed.events),
      events: parsed.events,
      skipped: parsed.skipped,
    };
  }

  /**
   * Whether a claimed piece of evidence can be found in this conversation's runs.
   *
   * This is the bridge batch G promised to `report_write`: a delivery is required to state
   * evidence, and now that the runs are on disk that claim can be CHECKED instead of trusted.
   * What it can establish is bounded and worth stating plainly:
   *
   *   - it can say "this conversation never ran `shell`, so a shell transcript cannot be its
   *     evidence" — the case that matters, where evidence was invented;
   *   - it can say "at least one distinctive token from this line appears in a recorded step";
   *   - it CANNOT say the output was quoted correctly, or that a step not run in this conversation
   *     did not happen. A human reading the trace does that.
   *
   * Deliberately lenient in one direction: the failure mode to avoid is a check that blocks honest
   * work because evidence was paraphrased. So the caller is expected to act on "NOTHING is backed",
   * not on a single unbacked line.
   */
  corroborate(sessionId: string | null, evidence: string, opts: { runs?: number } = {}): {
    backed: boolean;
    reason: string;
  } {
    const runs = this.sessionRuns(sessionId, opts.runs ?? 20);
    if (!runs.length) return { backed: false, reason: '这个会话还没有运行轨迹' };

    const corpus: string[] = [];
    const toolNames = new Set<string>();
    for (const r of runs) {
      corpus.push(r.prompt);
      const parsed = this.parse(`${r.id}.jsonl`);
      if (!parsed) continue;
      for (const e of parsed.events) {
        if (e.tool) toolNames.add(e.tool.toLowerCase());
        // Everything a reader could point at, lowercased once so matching is case-insensitive.
        corpus.push([e.text, e.tool, e.args, e.result, e.path].filter(Boolean).join(' ').toLowerCase());
      }
    }
    const haystack = corpus.join('\n');

    /*
     * A leading `tool:` prefix is how the delivery template asks for evidence to be written
     * (`shell: pnpm test → 12 passed`), so it is read as a claim about WHICH tool was used. When
     * it names a tool that never ran in this conversation, the line is not backed no matter what
     * else matches — that is the invented-evidence case.
     */
    const prefix = /^\s*([a-z_][a-z0-9_]{1,30})\s*[:：]/.exec(evidence);
    const claimedTool = prefix ? prefix[1].toLowerCase() : null;
    if (claimedTool && !toolNames.has(claimedTool)) {
      return { backed: false, reason: `这个会话没有调用过 \`${claimedTool}\`` };
    }

    const tokens = distinctTokens(evidence);
    const hit = tokens.find((t) => haystack.includes(t));
    if (hit) {
      return { backed: true, reason: `轨迹里出现过「${hit}」${claimedTool ? `，且 ${claimedTool} 确实跑过` : ''}` };
    }
    if (tokens.length === 0) {
      return { backed: false, reason: '这一行里没有可核对的内容（命令、路径、标识符）' };
    }
    return { backed: false, reason: `轨迹里找不到「${tokens[0]}」这类内容` };
  }

  /** Absolute path of the directory, for diagnostics and tests. */
  directory(): string {
    return this.dir;
  }

  private parse(file: string): { events: RunEvent[]; skipped: number } | null {
    const path = join(this.dir, file);
    let text: string;
    try {
      if (!existsSync(path)) return null;
      text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    } catch {
      // Unreadable (locked, permissions): the file exists, so it is not "no such run". Reported as
      // one damaged unit rather than thrown, because the caller is rendering a list.
      return { events: [], skipped: 1 };
    }
    const events: RunEvent[] = [];
    let skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as RunEvent;
        if (typeof parsed?.seq === 'number' && typeof parsed?.kind === 'string') events.push(parsed);
        else skipped++;
      } catch {
        // A half-written line from a process that died mid-append — precisely the run whose trace
        // matters most, so it is counted rather than discarded.
        skipped++;
      }
    }
    return { events, skipped };
  }
}

/** Words that appear in every trace, so matching on them says nothing. */
const STOPLIST = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'exit', 'code', 'true', 'false',
  'string', 'error', 'null', 'undefined', 'stdout', 'stderr', 'test', 'tests', 'file', 'files',
]);

/**
 * Tokens a person could have taken from an output.
 *
 * ASCII runs handle commands, paths and identifiers — the forms the delivery template asks for.
 * CJK runs are included because an evidence line written in Chinese may legitimately quote an
 * output line verbatim, and excluding them would mark every such line unbacked. Tokens shorter
 * than four characters are dropped: `the`, `//` and `a` match anything and would turn the check
 * into a formality that always passes.
 */
export function distinctTokens(evidence: string): string[] {
  const found: string[] = [];
  for (const m of evidence.matchAll(/[A-Za-z0-9_@./\\:-]{4,}/g)) {
    const t = m[0].replace(/^[./\\:-]+|[./\\:-]+$/g, '').toLowerCase();
    if (t.length >= 4 && !STOPLIST.has(t) && !found.includes(t)) found.push(t);
  }
  for (const m of evidence.matchAll(/[\u4e00-\u9fff]{4,}/g)) {
    if (!found.includes(m[0])) found.push(m[0]);
  }
  return found;
}
