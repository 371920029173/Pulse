import { createLogger } from '@she/shared';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

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
  /**
   * 调用成功了，但它的结论**没有可核对的依据**。
   *
   * 与 `empty` 的区别：`empty` 是"确实查了，结果是没有"；这是"看起来查了，其实没东西可查"。
   * 实测来源是一条第三方安全扫描 MCP：工作区里连 `package.json` 都没有，它照样回
   * 「✅ No known security vulnerabilities found!」，而那条结论被当成了"已通过安全检查"。
   *
   * 判据不是**文案**，是**文件系统**：要断言"没有漏洞"，前提是先有一份依赖清单可扫。清单不在，
   * 这条"干净"就不是结论，是空转 —— 报告里管它叫 guardian 假阴性，根因归在"无法判定默认落到
   * 允许"。所以它必须是一条独立的判定，不能借 `none` 混过去。
   */
  | 'vacuous'
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

  vacuous: {
    ok: false,
    retryable: false,
    remedy: '这次调用返回了"没有发现问题"的结论，但工作区里并没有它能扫的依赖清单，'
      + '所以这不是"检查通过"，是"没有检查"。不要把这条结论写进交付或报告；'
      + '要么先确认真实依赖清单的位置并指向它，要么如实说明"未扫描"及其原因。',
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
  /*
   * `fs_*` aimed at the knowledge-base file is refused with `Error: 知识库文件只能通过 kb_* 工具访问…`
   * (the `shell` spelling arrives as `DENIED:` and is already a refusal). It is policy, not an unknown
   * failure: the same call will be refused again and the fix is a different tool.
   */
  {
    kind: 'permission',
    re: /只能通过 kb_\* 工具访问/,
    from: 'sandbox tools.ts KB_DIRECT_ACCESS_REASON (fs_* on the KB database)',
  },
  {
    kind: 'invalid_args',
    re: /required|必填|不能为空|缺少|必须给|至少要给|不合法|非法|必须是|只能是|至少给|必须写|没有说明交付物|no usable tasks|createIfMissing/i,
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
    re: /没有可用的|当前没有|no matching pending|尚未|还没有|后台任务已达上限/i,
    from: 'preflight.ts `当前没有可分析的用户请求`, report/batch tools `没有可用的 batch`, sandbox shell.ts background-job capacity',
  },
  /*
   * An external MCP server answered a tool call with `isError` (or a JSON-RPC error). Last on
   * purpose: the server's own text is tried against every rule above first, so "no such file"
   * from the filesystem server still reads as `not_found`. What is left is a failure reported by
   * a remote service, which is what `service` describes.
   */
  {
    kind: 'service',
    re: /^MCP server .+ reported an error/i,
    from: 'server mcp-bridge.ts `mcpToolError` (MCP tool result with isError / JSON-RPC error)',
  },
];

/** Sentinels that mean "the call worked, and there is nothing to report". */
const EMPTY_SENTINELS = [
  /^No matches found\.?$/i, // sandbox tools.ts, grep
  /^No results found in Group KB\.?$/i, // agent-runtime kb-tools.ts, kb_query
];

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * 空扫描：说了"没有漏洞"，但没有东西可扫
 *
 * 实测原话：`mcp_guardian(scan_mode=summary)` 在工作区**没有 package.json** 的情况下返回
 * 「✅ No known security vulnerabilities found!」，而这条结论被当成"安全检查已通过"写进了报告。
 *
 * 判据刻意**不看文案**。第一次实现想从输出里找"package.json file not found"这类句子，但那条
 * 输出本身就同时印着一句「composer.json file not found」—— 一个真的扫过 package.json 的项目，
 * 只要它没有 composer.json，也会印这句，于是真扫描会被误判成空扫描。第三方输出措辞会变，靠它做
 * 判据就是把自己挂到别人的字符串上。
 *
 * 所以判据是**文件系统**：要断言"没有已知漏洞"，前提是先有一份能被扫的依赖清单。工作区里一份都
 * 没有的时候，"干净"不是结论，是空转。这是根因 B（"无法判定"落到"允许"）的一个具体形态：
 * 找不到清单不该报"无漏洞"，该报"未扫描"。
 */
const CLEAN_VERDICT = /no known (?:security )?vulnerabilit|0 vulnerabilit|未(?:发现|检出)[^\n]{0,8}漏洞|无已知漏洞|没有(?:已知)?漏洞/i;

/**
 * 哪些工具是**安全扫描器** —— 空扫描判据的适用范围。
 *
 * 这条限定是补上去的，原因是一次真实的误判：第一版只要求「输出里有"没有漏洞"这句话」且「工作区
 * 里没有依赖清单」，于是**任何**工具的输出只要碰巧提到这几个字就会被判成空扫描。实测（本地，
 * 无清单的工作区）六条里五条是误报：
 *
 *   - `fs_read` 读一份会话记录，里面存着上一轮报告的文字含「没有漏洞」→ 误判
 *   - `plan_list` 的计划标题里含这几个字 → 误判
 *   - `grep` 命中一行注释、`shell` 打印了 CHANGELOG、`kb_query` 检索到相关节点 → 全部误判
 *
 * 危害不止是"多一句提示"：`vacuous` 在错题本的**该记**名单里，所以这些误判被写成了 agent 的错题
 * （实测两条落在 `.she/kb.sqlite`：`fs_read` 失败类型 vacuous、`plan_list` 失败类型 vacuous）。读一份
 * 自己的会话记录被记成"做错了事"，比漏报更糟 —— 它会让模型下次不敢用这些工具。
 *
 * 收窄到工具名，而不是继续在文案上找特征：第三方输出的措辞会变，工具名是我们的。判断方向也换了 ——
 * 名字不像扫描器就**不判**。这样漏报一个名字古怪的扫描器（少说一句），而不是把普通工具的活动指控成
 * 空扫描（乱说一句）。
 */
const SCANNER_TOOL = /vulnerab|security[_-]?scan|scan[_-]?(?:security|deps?|dependencies)|dependency[_-]?(?:scan|check|audit)|npm[_-]?audit|snyk|trivy|grype|dependabot/i;

/** 任一存在就说明"有东西可扫"，这时扫描结果是真结论。 */
const DEPENDENCY_MANIFESTS = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'requirements.txt', 'pyproject.toml', 'poetry.lock', 'Pipfile',
  'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'composer.json', 'Gemfile', 'packages.config',
];

/** `.NET` 的清单是一个扩展名而不是一个固定文件名。 */
const MANIFEST_EXTENSIONS = ['.csproj', '.fsproj', '.vbproj', '.sln'];

/**
 * 工作区里有没有"可扫的依赖清单"。
 *
 * 扫三层目录，跳过 `node_modules`/`.git`/`dist`：再深就不是"这个工作区有没有清单"，而是"依赖树里
 * 有没有某个传递依赖的清单"，那是另一件事。三层是因为常见布局把清单放在二级目录里
 * （`packages/&lt;名字&gt;/package.json`），而扫描器自身的 cwd 通常就在根上 —— 两层只够看到
 * `packages/` 本身，会漏掉里面每一个清单。
 *
 * 只在**已经**匹配到"没有漏洞"结论时才被调用（见 `classifyToolResult` 的调用点），所以这次
 * `readdirSync` 不会出现在每一条工具结果的路径上。
 */
function hasDependencyManifest(root: string, depth = 3): boolean {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    /*
     * 读不到目录：**当作"有清单"**。
     *
     * 这条检查会让模型不去相信一条结论，误报的代价是它多做一次核对。反之，把"读不到"当成
     * "没有清单"就会凭空产出"这是空扫描"的指控。两种错里，宁可少说。
     */
    return true;
  }
  for (const e of entries) {
    if (e.isFile()) {
      if (DEPENDENCY_MANIFESTS.includes(e.name)) return true;
      if (MANIFEST_EXTENSIONS.some((ext) => e.name.endsWith(ext))) return true;
    }
  }
  if (depth <= 1) return false;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
    if (hasDependencyManifest(join(root, e.name), depth - 1)) return true;
  }
  return false;
}

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
 * @param opts `workspaceRoot` enables the empty-scan check. Omitted by callers that have no
 *   workspace in hand (tests, the check scripts) — the rest of the classification is a pure
 *   function of the text, and stays that way.
 */
export function classifyToolResult(
  name: string,
  raw: unknown,
  opts: { workspaceRoot?: string } = {},
): ToolResultVerdict {
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

  /*
   * 空扫描，判在 `^Error:` 之前。
   *
   * 一个安全扫描器的"没有漏洞"是**成功**返回（guardian 那条 `ok: true, failure: none`），所以
   * 它永远走不到下面那段错误分类里 —— 想让它被看见，只能在这里截住。三条都要满足才判定：这次调用
   * **是安全扫描器**、文本给出了"干净"结论、且工作区里一份依赖清单都没有。缺任何一条都退回原路径，
   * 绝不猜。第一条是后补的：没有它，任何输出里碰巧提到"没有漏洞"的工具都会被误判（详见
   * `SCANNER_TOOL` 的注释）。
   */
  if (
    opts.workspaceRoot
    && SCANNER_TOOL.test(name)
    && CLEAN_VERDICT.test(trimmed)
    && !hasDependencyManifest(opts.workspaceRoot)
  ) {
    return verdict('vacuous');
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
