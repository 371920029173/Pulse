import { createLogger } from '@she/shared';

const log = createLogger('tool-result');

/**
 * What a tool result actually means, and what to do about it.
 *
 * The gap this closes: the loop treated every tool result as opaque text and looked only
 * for `^Error:`, so three classes of failure were invisible or indistinguishable.
 *
 *   1. **A non-zero exit code was a success.** `shell` renders `exit code: 1` as ordinary
 *      text, so a failed command was counted as healthy and the model got no signal that
 *      anything went wrong.
 *   2. **"No matches" read as data.** `grep` returning `No matches found` and `kb_query`
 *      returning `No results found in Group KB.` are SUCCESSFUL queries whose answer is
 *      "nothing". With no way to say so, the pressure is to fill the gap — the exact
 *      mechanism behind inventing facts the prompt already forbids.
 *   3. **Every failure looked alike.** "argument is required", "no such file" and "the
 *      service refused the connection" need three different next actions. Telling the
 *      model only that something failed invites an identical retry.
 *
 * So the value here is not the label, it is the REMEDY: each kind maps to the one thing
 * that can actually work next, and `retryable` says whether repeating the identical call
 * is a waste. That is the signal the stuck-loop detector needs and does not have.
 *
 * Every pattern is copied from a string a tool in this repository really produces, and the
 * producer is named in a comment. A rule that matches nothing is noise; a rule that misses
 * is a silent regression, which is why `scripts/tool-result-check.mjs` drives the real
 * producers rather than restating these patterns.
 *
 * Deliberately NOT here: anything needing the model's judgement (was the answer good
 * enough?). This is a deterministic reading of a string, which is the only reason it can
 * run on every call, for free, in the gate.
 */
export type ToolFailureKind =
  /** The call worked and returned usable content. */
  | 'none'
  /** The arguments are wrong, missing or unusable. */
  | 'invalid_args'
  /** The sandbox refused the action, by policy or by jail. */
  | 'permission'
  /** The tool itself is not available in this session. */
  | 'unavailable'
  /** The thing the call names does not exist. */
  | 'not_found'
  /**
   * The call is well-formed but the current state does not allow it.
   *
   * Distinct from `invalid_args` in what the model must do about it: changing the arguments
   * will not help, because the arguments were never the problem — something else has to
   * happen first (a plan has to be open, a batch has to be rebuilt, a request has to exist).
   */
  | 'precondition'
  /** The call succeeded and the honest answer is "nothing". */
  | 'empty'
  /** The remote side is unreachable or broken. */
  | 'service'
  /** The call exceeded its time budget. */
  | 'timeout'
  /** Throttled by the remote side; the same call can work later. */
  | 'rate_limited'
  /** A command ran and failed. Distinct from never having run. */
  | 'nonzero_exit'
  /** A tool reported failure in a way no rule recognises. */
  | 'unknown';

export interface ToolResultVerdict {
  kind: ToolFailureKind;
  /**
   * False when the call produced no usable data.
   *
   * `empty` is false: the call succeeded but the agent has gained nothing, and it must not
   * proceed as though it had. `none` is the only true value, which keeps "did I learn
   * anything?" a single question instead of two.
   */
  ok: boolean;
  /**
   * True only when repeating the IDENTICAL call could plausibly help.
   *
   * A transient transport failure or a query that ran before its data landed is retryable;
   * wrong arguments, a missing file and a refusal are not.
   */
  retryable: boolean;
  /**
   * One line telling the model what to do next, or null when nothing needs saying.
   *
   * MUST be a pure function of the kind. It is appended to the tool result, and the
   * stuck-loop signature is built from that result: a remedy carrying a timestamp or a
   * counter would make every repeat look different and silently disable loop detection.
   */
  remedy: string | null;
}

/**
 * The single table. Kind to meaning.
 *
 * One table rather than a remedy at each return site: the whole point is that these
 * DIFFER, so having them side by side is what makes an accidental duplicate visible. An
 * earlier version inlined them and left three kinds with placeholder text — the shape of
 * the table is what prevents that.
 *
 * `ok` and `retryable` live here rather than at each detection site for the same reason:
 * two places deciding whether a kind is retryable is two places to disagree.
 */
const KINDS: Record<ToolFailureKind, { ok: boolean; retryable: boolean; remedy: string | null }> = {
  none: { ok: true, retryable: false, remedy: null },

  invalid_args: {
    ok: false,
    retryable: false,
    remedy: '参数不对，不是环境的问题。按提示补全或改正参数后再调用——'
      + '用同样的参数重试一次，结果不会变。',
  },

  permission: {
    ok: false,
    retryable: false,
    remedy: '沙箱按策略拒绝了这次调用。不要重试，也不要换一种写法去达成同一件事——'
      + '需要的话说明想做什么、为什么，由用户决定是否放行。',
  },

  unavailable: {
    ok: false,
    retryable: false,
    remedy: '这个工具在当前会话里不可用。不要重试，也不要当作暂时故障——'
      + '换一个真能做到这件事的工具，或者如实说明你需要的能力还没有。',
  },

  not_found: {
    ok: false,
    retryable: false,
    remedy: '点名的东西不存在。先确认路径或标识写对了（前缀、大小写、是否该先创建），'
      + '原样重试一定还是同样的结果。',
  },

  precondition: {
    ok: false,
    retryable: false,
    remedy: '这次调用的写法没问题，但现在还不具备执行它的条件——改参数没有用，'
      + '需要先让状态变成它要求的样子（例如先建计划、先重建批次、先收到一条用户消息）。'
      + '先检查当前状态，再决定要不要做那一步。',
  },

  empty: {
    ok: false,
    retryable: false,
    remedy: '查询本身成功了，只是没有任何匹配。这就是答案，不要用同样的条件重查，'
      + '也不要把没查到的部分说成已知；要么放宽条件再查一次，要么如实说明没有找到。',
  },

  service: {
    ok: false,
    retryable: true,
    remedy: '远端连不上或返回了错误——这一次不能当作"没有数据"。可以重试一次；'
      + '连续失败就是对方的问题，不要反复重试，直接说明现状。',
  },

  timeout: {
    ok: false,
    retryable: true,
    remedy: '这次调用超时了。可以重试一次；再超时就把请求改小（缩小范围、减少条数、加过滤条件），'
      + '比原样重来更可能成功。',
  },

  rate_limited: {
    ok: false,
    retryable: true,
    remedy: '被限流了。隔一会儿再用同一个调用通常有效，但不要紧凑地连续重试。',
  },

  nonzero_exit: {
    ok: false,
    retryable: false,
    remedy: '命令确实跑了，但退出码不是 0——失败在命令本身，不在调用。先读 stderr 判断原因；'
      + '同样的命令重跑一次不会变好。注意有些命令用非零退出码表示"没找到"（grep、diff），'
      + '先分清是这两种，还是真的报错。',
  },

  unknown: {
    ok: false,
    retryable: false,
    remedy: '工具报告了失败，但原因不属于已知类别。读一遍原始输出再决定，不要原样重试。',
  },
};

const verdict = (kind: ToolFailureKind): ToolResultVerdict => ({ kind, ...KINDS[kind] });

/**
 * A rule, tested in order.
 *
 * Order is load-bearing, not cosmetic. A refusal and a transport failure are both reported
 * as text and can both mention connections, while the actions they need are opposites: one
 * needs a human, the other needs a retry. So the more specific claim is tried first.
 */
interface Rule {
  kind: ToolFailureKind;
  re: RegExp;
  /** Where this string comes from, for whoever has to change it later. */
  from: string;
}

const RULES: Rule[] = [
  { kind: 'timeout', re: /timed out|timeout|超时|ETIMEDOUT/i, from: 'shell.ts `(timed out)`, undici ETIMEDOUT' },
  { kind: 'rate_limited', re: /\b429\b|rate.?limit|too many requests|限流/i, from: 'provider HTTP 429 handling' },
  {
    kind: 'service',
    re: /ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|bad gateway|service unavailable|连接被拒绝|服务不可用/i,
    from: 'provider transport errors (undici)',
  },
  {
    kind: 'unavailable',
    re: /unknown tool|unknown KB tool|is not available|工具不存在|工具不可用/i,
    from: 'sandbox tools.ts, kb-tools.ts, plugins.ts',
  },
  /*
   * A workspace-escape is a refusal, and it arrives as a THROWN Error rather than the
   * `DENIED:` prefix, so it needs a rule of its own. Found by `tool-result-check.mjs`
   * driving `fs_read` at `../../../etc/passwd`: the message was classified as `unknown`,
   * i.e. the model was told "something failed" when the truth was "the sandbox stopped you
   * and no rewrite of the path will help".
   */
  {
    kind: 'permission',
    re: /escapes workspace|工作区外|只允许工作区内/i,
    from: 'shell.ts `Path escapes workspace`, `cd 目标在工作区外`, ingest-tools.ts',
  },
  /*
   * The output-side guardrail refuses to write a file containing a detected secret. It is a
   * policy refusal, not a bad argument: the same call with the same path will be refused
   * again, and only a human can decide whether the value really belongs in the file. Telling
   * the model "something failed" would invite it to retry, which is the wrong move twice over.
   */
  {
    kind: 'permission',
    re: /已拒绝写入|检测到敏感内容/,
    from: 'guardrail.ts `交付文件里检测到敏感内容，已拒绝写入`',
  },
  {
    kind: 'invalid_args',
    re: /required|必填|不能为空|缺少|必须给|至少要给|不合法|非法|必须是|没有说明交付物|no usable tasks|createIfMissing/i,
    from: 'plan-tools.ts / memo-tools.ts / kb-tools.ts / errorbook.ts / subagent-tools.ts argument checks',
  },
  {
    kind: 'not_found',
    re: /not found|no such file|不存在|未找到|找不到/i,
    from: 'sandbox tools.ts `路径不存在`, kb-tools.ts `未找到条目`, plan-tools.ts `plan not found`',
  },

  /*
   * ── Something else has to happen first. ──
   * Placed last because these phrases are the vaguest of the set and would otherwise shadow
   * a more specific diagnosis. `没有可用的 batch` belongs here rather than under
   * `unavailable`: the tool IS installed, there is simply nothing for it to work on yet.
   */
  {
    kind: 'precondition',
    re: /没有可用的|当前没有|no matching pending|尚未|还没有/i,
    from: 'preflight.ts `当前没有可分析的用户请求`, report/batch tools `没有可用的 batch`',
  },
];

/** Sentinels that mean "the call worked, and there is nothing to report". */
const EMPTY_SENTINELS = [
  /^No matches found\.?$/i, // sandbox tools.ts, grep
  /^No results found in Group KB\.?$/i, // agent-runtime kb-tools.ts, kb_query
];

/**
 * `shell`'s own trailing marker for a command it gave up waiting on (tools.ts).
 *
 * Anchored to the END of the output, not to any line: `tools.ts` appends it last, after the
 * exit code. Matching it as an arbitrary line was a false positive waiting to happen —
 * `stdout:\n(timed out)\nexit code: 0` is a program that PRINTED the words, not a command
 * that was killed, and telling the model its command timed out would be a lie.
 */
const TIMED_OUT_MARKER = /\(timed out\)\s*$/;

/**
 * `exit code: N` exactly as `shell` renders it.
 *
 * The LAST match wins, not the first. The line is appended after stdout and stderr, so a
 * command whose output merely contains a line reading `exit code: 1` would otherwise have
 * its own output forged into its exit status.
 */
const EXIT_CODE_LINE = /^exit code:\s*(-?\d+)\s*$/gm;

/**
 * The exit code `shell` reported, or null when this is not a shell result.
 *
 * Takes the LAST occurrence: the status line is appended after stdout and stderr, so a
 * command whose own output contains `exit code: 1` must not have that forgery read as its
 * exit status. With `g` set, `re.exec` continues from `lastIndex`, so the final match is
 * read by iterating to the end.
 */
function lastExitCode(text: string): number | null {
  EXIT_CODE_LINE.lastIndex = 0;
  let found: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = EXIT_CODE_LINE.exec(text)) !== null) {
    found = Number(m[1]);
    // Defensive: a zero-width match would spin, though this pattern cannot produce one.
    if (m.index === EXIT_CODE_LINE.lastIndex) EXIT_CODE_LINE.lastIndex++;
  }
  return found;
}

/** The provider's error shape (`openai.ts`): `OpenAI API error 500: ...`. */
const API_STATUS = /API error (\d{3})/i;

/**
 * Which family an HTTP status belongs to.
 *
 * The four families need four different actions, which is the only reason to look at the
 * code at all: a 5xx may work on a retry, a 429 must wait, a 4xx will not change however
 * many times it is sent, and 401/403 means a human has to decide.
 */
function kindForStatus(code: number): ToolFailureKind {
  if (code === 429) return 'rate_limited';
  // 408 is the server giving up on the request, 504 a gateway doing the same.
  if (code === 408 || code === 504) return 'timeout';
  if (code >= 500) return 'service';
  if (code === 401 || code === 403) return 'permission';
  // 404 here means the model or endpoint named does not exist, which is a wiring problem
  // rather than a bad argument — retrying or rephrasing cannot fix it.
  if (code === 404) return 'unavailable';
  // Any other 4xx: the request itself was wrong.
  return 'invalid_args';
}

/**
 * Waiting for a human is a state, not a failure.
 *
 * Both forms are produced by the confirm gate and the patch stager. Counting them as
 * failures would inflate the failure metric and, worse, tell the model its call broke when
 * the system is working exactly as designed.
 */
const AWAITING_HUMAN = /"needs_confirm"|"needs_apply"/;

/**
 * Read one tool result.
 *
 * @param name tool name, used only for the log line when nothing matches
 * @param raw the value the executor returned, after the confirm-gate redaction
 */
export function classifyToolResult(name: string, raw: unknown): ToolResultVerdict {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  const trimmed = text.trim();

  if (AWAITING_HUMAN.test(text)) return verdict('none');

  /*
   * `DENIED:` is the sandbox's own prefix (tools.ts), so it is read AS a prefix rather than
   * matched inside a message: `grep DENIED` would otherwise classify its own search hits —
   * or a genuine command's output quoting the word — as a refusal.
   */
  if (/^DENIED:/i.test(trimmed)) return verdict('permission');

  /*
   * Emptiness is decided before the error rules, because a tool returning nothing is not an
   * error: `grep` with no matches is a correct answer. The sentinels are matched WHOLE
   * (`^...$`) so a longer message that merely quotes one cannot be swallowed as "empty".
   */
  if (trimmed === '') return verdict('empty');
  if (EMPTY_SENTINELS.some((re) => re.test(trimmed))) return verdict('empty');

  /*
   * A shell result is recognised by its status line, and read as a WHOLE shape.
   *
   * `shell` renders `exit code: N`, appending `(timed out)` when it gave up — so a timed-out
   * command satisfies BOTH markers, and checking the exit code first reported a timeout as an
   * ordinary failure. That distinction is not cosmetic: a timeout is worth retrying with a
   * smaller request, a failed command is not worth repeating at all.
   *
   * Read as a shape rather than by scanning the text for words, because the text here is
   * arbitrary program output: `grep timeout` would otherwise classify its own hits as a
   * timeout, and `grep ECONNREFUSED` as a dead service.
   */
  const exit = lastExitCode(trimmed);
  if (exit !== null) {
    if (TIMED_OUT_MARKER.test(trimmed)) return verdict('timeout');
    if (exit !== 0) return verdict('nonzero_exit');
    // Exit 0 with output: an ordinary success, even if the output mentions errors.
    return verdict('none');
  }

  if (!/^Error:/i.test(trimmed)) return verdict('none');

  const body = trimmed.replace(/^Error:\s*/i, '');

  /*
   * The provider's own error shape: `OpenAI API error 500: ...` (openai.ts). Checked as a
   * STATUS rather than matched by wording, because it is the one producer that reports a
   * machine-readable reason and a bare `500` in prose would otherwise be a guess. Placed
   * before the table because a status is strictly more specific than any phrase.
   */
  const status = body.match(API_STATUS);
  if (status) return verdict(kindForStatus(Number(status[1])));

  for (const rule of RULES) {
    if (rule.re.test(body)) return verdict(rule.kind);
  }

  /*
   * `unknown` rather than a guess. Which rule to add is a judgement for whoever sees the
   * message, and `tool-result-check.mjs` asserts that every `^Error:` producer in the tree
   * classifies, so a new one arriving here fails the gate instead of quietly passing as a
   * success.
   */
  log.warn(`无法分类的工具失败（${name}）：${body.slice(0, 200)}`);
  return verdict('unknown');
}

/**
 * Append the remedy to what the model reads.
 *
 * Separate from `classifyToolResult` so the classification can be asserted on its own, and
 * so what the model reads is decided at the call site instead of hidden inside the reader.
 * Returns the input unchanged when there is nothing to add, so it is safe on every result.
 */
export function annotateToolResult(raw: unknown, v: ToolResultVerdict): string {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  if (!v.remedy) return text;
  /*
   * Prefixed so the annotation is distinguishable from the tool's own words — in the
   * transcript, in a bug report, and by the UI. Deliberately NOT `[系统提示]`, which the
   * stuck-loop nudge uses as its marker: reusing it would make an ordinary argument error
   * look like a loop intervention, and would break the tests that key on that marker.
   */
  return `${text}\n\n[tool-result] ${v.remedy}`;
}

/**
 * True when this verdict should be counted as a failed tool call.
 *
 * Read off `KINDS` rather than written as `kind !== 'none'`: the table already decides `ok`
 * per kind, and restating the rule here is the "two places to disagree" the table exists to
 * prevent. Note that `ok` means "this call produced data", not "the tool is broken" — an
 * empty result counts as a failure, because a query that found nothing did not answer the
 * question it was asked.
 */
export function isToolFailure(v: ToolResultVerdict): boolean {
  return !KINDS[v.kind].ok;
}
