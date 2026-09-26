import type { LLMMessage, ToolDefinition } from '@she/shared';

/**
 * Subagent delegation.
 *
 * The parent agent can hand a self-contained subtask to a child that runs with
 * its OWN context and reports back a summary. The point is context hygiene:
 * exploring 30 files to answer one question would otherwise fill the parent's
 * transcript with material it never needs again.
 *
 * This module owns the TOOL only. Constructing a child agent is the caller's
 * business (`SubagentRunner`), which keeps agent-runtime free of any dependency
 * on how agents are built or where their tools come from.
 */

export interface SubagentRequest {
  /** Short label, shown in progress output. */
  description: string;
  /** Self-contained instructions. The child cannot see the parent's history. */
  prompt: string;
  /**
   * Return as soon as the child has a session, and let it keep running.
   * The parent is not blocked, and the child transcript stays on that session.
   */
  background?: boolean;
  /**
   * Whether to run the child in its own git worktree.
   *
   *   - `'worktree'`: always, when the workspace is a git repository.
   *   - `'none'`: never — the child shares the parent's checkout.
   *   - `'auto'` (default): only when the task DECLARES a writable `scope`.
   *
   * The `auto` rule is deliberately narrow. A child that only reads is the common case, and
   * isolating it would be actively worse: a worktree starts from `HEAD`, so a child asked to
   * review "my current changes" would be looking at the last commit instead of the dirty tree.
   * A child that declares it will write, on the other hand, races the parent and any sibling on
   * exactly the files it names — that is the case where a private tree pays for itself.
   */
  isolation?: 'auto' | 'worktree' | 'none';
  /** Structured job description; see `SubagentHandoff`. */
  handoff?: SubagentHandoff;
  /**
   * Wall-clock budget for this child, in milliseconds.
   *
   * Per task because the right number depends on the job, not on the runtime: a search that reads
   * twenty files finishes in seconds, a review that runs a full build does not. One global value
   * made the heavy case impossible to run at all — the measured complaint was a subtask that had
   * already been trimmed to its smallest form and still hit the 180s ceiling, with the whole run
   * discarded. Implementations clamp it; the caller states what the task is worth.
   */
  timeoutMs?: number;
}

/**
 * What the child owes the parent, stated as fields rather than prose.
 *
 * A prompt alone makes the parent's request and the child's report both free text, so the parent
 * has to re-read a summary to work out whether the child stayed in scope, and a child that
 * wandered has no way to know it did. These four fields are the ones the parent always knows and
 * the child always needs, and putting them in the request means they can be repeated back
 * verbatim in the result instead of being inferred.
 */
export interface SubagentHandoff {
  /** The artifact the child must produce: a report, a fix, a file. One sentence. */
  deliverable?: string;
  /** Paths the child may modify. Anything outside is out of scope and must not be touched. */
  scope?: string[];
  /** Hard rules: "read-only", "no new dependencies", "do not touch package.json". */
  constraints?: string[];
  /** Facts already established, so the child does not spend its budget re-deriving them. */
  context?: string[];
}

/**
 * Where a child actually ran, and what it left behind.
 *
 * Returned for an isolated child so the parent can see the work exists and where it lives. The
 * changed paths are the point: the parent's transcript never contains the child's editing, so
 * without this list a successful isolated subtask looks identical to one that did nothing.
 */
/**
 * A live reading of what a child is doing, taken from its own transcript.
 *
 * Exists because a delegated task is the one long-running thing whose intermediate state nobody
 * could see. The parent is blocked inside a tool call, so it cannot be shown anything mid-flight;
 * the two audiences that CAN be served are the human watching the spinner and the parent reading
 * the reply after a timeout. Both are served by the same reading, so it is derived once, here,
 * from the child's messages — rather than reconstructed by each caller from a private copy.
 */
export interface ChildProgress {
  /** Tool calls it has completed. */
  steps: number;
  /** The call it is on right now, one line: `shell pnpm test`. */
  activity: string;
  /** The last few calls, oldest first, for a post-mortem. */
  recent: string[];
  /** The last thing it said in its own words, newlines folded away. */
  lastWords?: string;
}

/**
 * Argument keys worth showing in a one-line reading, most specific first.
 *
 * A tool call's meaning is in one of its arguments, and dumping the whole JSON gives a wall of
 * escaped text that nobody reads. Order matters: `shell` carries both `command` and `cwd`, and the
 * command is the part that says what is happening.
 */
const SALIENT_ARGS = ['command', 'cmd', 'path', 'file_path', 'pattern', 'query', 'url', 'title'];

/** Collapse to a single line and clip, so one reading is always one line. */
function oneLine(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The most telling argument of a call, as one line. Empty when there is nothing to show. */
function shortArg(raw: string): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of SALIENT_ARGS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return oneLine(value, 70);
    }
    const first = Object.values(parsed).find((v) => typeof v === 'string' && v.trim());
    return typeof first === 'string' ? oneLine(first, 70) : '';
  } catch {
    // A half-formed argument stream is normal in a live reading; show what arrived.
    return oneLine(raw, 70);
  }
}

export function readChildProgress(messages: LLMMessage[]): ChildProgress {
  const recent: string[] = [];
  let lastWords: string | undefined;
  let steps = 0;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const call of m.tool_calls ?? []) {
      const name = call.function?.name ?? 'tool';
      const arg = shortArg(call.function?.arguments ?? '');
      steps++;
      recent.push(arg ? `${name} ${arg}` : name);
    }
    const said = oneLine(m.content ?? '', 200);
    if (said) lastWords = said;
  }
  return {
    steps,
    activity: recent.length ? recent[recent.length - 1] : '正在思考（还没有调用工具）',
    recent: recent.slice(-8),
    lastWords,
  };
}

/**
 * What the parent is told when a child runs out of time.
 *
 * A bare `子任务超时` was the whole reply, and that is the worst possible answer: the parent learns
 * nothing about 180 seconds of work, so its options collapse to re-dispatching the same task and
 * paying for it twice. This reports what the child got done, what it said, what it changed, where
 * its transcript lives, and — the part that prevents a repeat — that the budget itself is a
 * parameter. The work is stopped either way; the difference is whether it leaves a trace.
 */
export function formatTimeoutReport(
  progress: ChildProgress,
  opts: { seconds: number; sessionId: string; changed?: string[]; worktreePath?: string },
): string {
  const lines = [`子任务超时：${opts.seconds}s 预算用尽，已中止（没有结果返回）。`];
  if (progress.steps === 0) {
    lines.push('它一个工具都还没调用完 —— 超时不在工作量上，更可能是它在等模型或卡在某个调用上。');
  } else {
    lines.push('');
    lines.push(`它做到哪一步（超时前最后 ${progress.recent.length} 次调用，共 ${progress.steps} 次）：`);
    progress.recent.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
  }
  if (progress.lastWords) lines.push('', `它最后说的是：${progress.lastWords}`);
  if (opts.changed?.length) {
    lines.push('', `它已经改动的文件：${opts.changed.join('、')}`);
    if (opts.worktreePath) lines.push(`（在隔离副本 ${opts.worktreePath} 里，没有合并回主工作区）`);
  }
  lines.push(
    '',
    `完整过程在子会话 ${opts.sessionId} 里，可以打开看它做了什么。`,
    '重派时给足预算：这个任务比默认的重。再发一次时带 `timeout_ms`（例如 600000 = 10 分钟），',
    '或者带 `background: true` —— 那样它不再阻塞本轮，作为独立会话继续跑完。',
  );
  return lines.join('\n');
}

export interface SubagentWorktree {
  path: string;
  branch: string;
  /** Repo-relative paths the child touched, from `git status --porcelain`. */
  changed: string[];
  /** Why isolation did not happen, when it was asked for and not granted. */
  note?: string;
}

/** The slice of a KB node the harvest needs. Structural, so this module needs no KB dependency. */
export interface HarvestCandidate {
  title: string;
  kind: string;
  content: string;
  /** `errorbook: true` marks a node the error book wrote, rather than the child. */
  metadata?: Record<string, unknown>;
}

/** How many notes the reply lists before it starts pointing at the digest file instead. */
export const HARVEST_INLINE_MAX = 10;
const HARVEST_EXCERPT_CHARS = 160;

function clip(value: string, max: number): string {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Read what a child wrote out of its copy of the knowledge base.
 *
 * Everything it wrote, trimmed only by length, so the caller can decide what the reply shows and
 * what the digest file has to hold. `written` is the count before any trimming, because a list
 * that has been shortened must not read as "this is all of it".
 *
 * Self-review nodes are excluded by their marker rather than by their group: a child's findings
 * are measured against the PARENT's goal (the child has no `preflight_*` of its own), so most of
 * them are false alarms about someone else's request. Counting them keeps the fact visible without
 * handing the parent mistakes it never made.
 */
export function selectHarvestNotes(
  nodes: HarvestCandidate[],
  opts: { excerptChars?: number } = {},
): SubagentKbHarvest {
  const chars = opts.excerptChars ?? HARVEST_EXCERPT_CHARS;
  const notes: HarvestNote[] = [];
  let selfReview = 0;
  for (const n of nodes) {
    if (n.metadata?.errorbook === true) {
      selfReview++;
      continue;
    }
    notes.push({
      title: clip(n.title, 120),
      kind: String(n.kind ?? ''),
      excerpt: clip(n.content, chars),
      content: String(n.content ?? '').trim(),
    });
  }
  return { notes, written: notes.length, selfReview };
}

/**
 * The harvest, as lines of the parent's reply.
 *
 * Shown next to the child's own answer because it is the other half of what the child produced:
 * the answer says what it concluded, this says what it wrote down on the way. Empty when there is
 * nothing to say, so the caller can append it unconditionally.
 */
export function renderKbHarvest(harvest: SubagentKbHarvest): string[] {
  if (!harvest.notes.length && !harvest.selfReview) return [];
  const lines: string[] = [];
  const shown = harvest.notes.slice(0, HARVEST_INLINE_MAX);
  if (shown.length) {
    lines.push(`- 它在自己的知识库副本里写下的笔记（${harvest.written} 条；副本已随子任务清理，`
      + '值得留的用 `kb_upsert` 搬进主库，其余就此作废）：');
    for (const n of shown) lines.push(`  - ${n.title}${n.kind ? `（${n.kind}）` : ''}：${n.excerpt}`);
    if (harvest.written > shown.length) {
      lines.push(`  - 还有 ${harvest.written - shown.length} 条没有列在这里。`);
    }
    if (harvest.digestPath) {
      lines.push(`  全文（每条的完整内容，不只是开头）在 ${harvest.digestPath}`);
    }
  }
  if (harvest.selfReview) {
    lines.push(`- 另有 ${harvest.selfReview} 条它自己的自省记录（漂移、重复失败等）没有并入：`
      + '那些条目是拿父级的目标衡量子级的动作得出来的，误报居多。');
  }
  return lines;
}

/**
 * One note a child wrote, clipped to what a parent needs in order to judge it.
 *
 * A title and the opening words, not the whole node: the parent is deciding whether to absorb it,
 * and `kb_upsert` with the same title and content is how it does that. An excerpt that is too
 * short to tell two notes apart would make the decision a guess.
 */
export interface HarvestNote {
  title: string;
  kind: string;
  /** The opening words: what the reply shows, enough to judge whether the note is worth absorbing. */
  excerpt: string;
  /** The whole note, unclipped. Kept because the copy it came from is deleted: the digest file is
   *  the last place this text exists, and a note nobody can read in full is not harvested at all. */
  content: string;
}

/**
 * What a finished child left in its knowledge base.
 *
 * Why this exists: a child writes into a PRIVATE copy of the parent's KB (it cannot be allowed to
 * edit the parent's memory unreviewed), and that copy is discarded when the child ends. Discarding
 * it silently threw away the one thing the child produced deliberately — its notes — leaving the
 * conclusions to survive only if the child remembered to repeat them in prose. Reported instead:
 * the child writes notes as it goes, and the parent gets them as a list it can absorb with one
 * call each.
 *
 * The copy is deleted either way. What is harvested is a reading, not a merge: nothing reaches the
 * parent's memory without the parent deciding, which is the same rule the child was told.
 */
export interface SubagentKbHarvest {
  /** Notes it wrote, oldest first, each clipped. Everything it wrote, unless a caller trimmed. */
  notes: HarvestNote[];
  /** How many notes were written in total — equal to `notes.length` unless trimmed. */
  written: number;
  /**
   * Its own self-review records (drift, repeated failures), left out of `notes`.
   *
   * These are entries the runtime writes about the CHILD, judged against the PARENT's goal and
   * constraints — measured on a read-only child they are mostly false alarms, and absorbing them
   * would put mistakes the parent never made into the parent's book. Counted rather than dropped
   * so the parent can see that the child's book was not empty.
   */
  selfReview: number;
  /** File holding the full digest, when it did not fit here. Set by the caller that wrote it. */
  digestPath?: string;
}

export interface SubagentResult {
  description: string;
  ok: boolean;
  /** The child's final message, or an error description. */
  result: string;
  /** What the child wrote into its private knowledge base, before the copy was deleted. */
  kbHarvest?: SubagentKbHarvest;
  /** Echoed back so the parent can check scope without re-reading the prompt it wrote. */
  handoff?: SubagentHandoff;
  worktree?: SubagentWorktree;
  /**
   * Whether the isolation this task asked for was actually granted.
   *
   * Separate from `worktree` because the interesting case is the one with NO worktree: a parent that
   * declared a writable scope believes the child is editing a private copy, and if the worktree
   * could not be created — no git repository, git missing, the branch taken — it is editing the
   * shared checkout instead. Staying silent there is the worst outcome available, so the answer is
   * a required field rather than a note attached to the success story.
   */
  isolation?: {
    requested: boolean;
    applied: boolean;
    /** Why it was not applied. Absent when it was, or when nothing was asked for. */
    note?: string;
  };
}

/**
 * Whether this task should get a private tree.
 *
 * Exported because it is a decision with a rule, and a rule that only exists inside a closure is
 * a rule nobody can test.
 */
export function shouldIsolate(
  req: Pick<SubagentRequest, 'isolation' | 'handoff'>,
  isGitRepo: boolean,
): boolean {
  if (!isGitRepo) return false;
  if (req.isolation === 'none') return false;
  if (req.isolation === 'worktree') return true;
  return (req.handoff?.scope?.length ?? 0) > 0;
}

export interface ComposeOptions {
  /** Absolute directory the child will work in — its worktree when isolated. */
  workdir: string;
  /** True when `workdir` is a private copy the parent will not see changes in automatically. */
  isolated: boolean;
  /**
   * How the child's knowledge base relates to the parent's.
   *
   * `snapshot` — a private copy of the parent's KB. Reads work; writes land in the copy and are
   *   reported back to the parent when the child ends, then the copy is deleted. This is the normal
   *   case: every child gets its own writable copy, so nothing it writes can reach the parent's
   *   memory unreviewed and nothing it learns is lost with the copy.
   * `shared` — the parent's own file, and therefore READ-ONLY for the child. A fallback for when no
   *   private copy could be created at all: a write there would be a permanent, unreviewed edit to
   *   the parent's memory, and the alternative is a child that cannot run.
   * `empty` — there was nothing to copy, or the copy failed.
   *
   * Undefined is NOT the same as `shared`: the caller says which it is, and silence means nobody
   * established it. A child told nothing about its memory has no way to read a "no results" answer
   * correctly — it cannot tell "this project never recorded that" from "my memory is not here".
   */
  kb?: 'snapshot' | 'shared' | 'empty';
  /**
   * Wall-clock budget, in seconds. Stated in the brief when known.
   *
   * A child that does not know it is on a clock spends its whole budget gathering and is killed
   * before it writes anything down — the measured failure was a 180s subtask that returned nothing
   * at all. Telling it the number turns a silent trap into something it can plan around: gather
   * less, conclude sooner, hand in what it has.
   */
  deadlineSeconds?: number;
}

/**
 * Build the child's prompt: the handoff document, then the parent's own instructions.
 *
 * The block comes first on purpose. A child reads its instructions in order, and the one thing it
 * must not miss — that its changes land in a copy, not in the project — is worthless at the end of
 * a long prompt.
 */
export function composeHandoffPrompt(req: SubagentRequest, opts: ComposeOptions): string {
  const h = req.handoff ?? {};
  const lines: string[] = ['## 交接单', ''];
  lines.push(`- 交付物：${h.deliverable?.trim() || req.description}`);
  lines.push(`- 工作目录：${opts.workdir}`);
  const scope = (h.scope ?? []).map((s) => s.trim()).filter(Boolean);
  lines.push(
    scope.length
      ? `- 允许改动：${scope.join('、')}（这个范围之外的文件不要动；需要动就先说明再停手）`
      : '- 允许改动：无 —— 这是只读任务，不要修改、创建或删除任何文件',
  );
  const constraints = (h.constraints ?? []).map((s) => s.trim()).filter(Boolean);
  if (constraints.length) {
    lines.push('- 约束：');
    for (const c of constraints) lines.push(`  - ${c}`);
  }
  const context = (h.context ?? []).map((s) => s.trim()).filter(Boolean);
  if (context.length) {
    lines.push('- 已知情况（父智能体已确认，不必重新验证）：');
    for (const c of context) lines.push(`  - ${c}`);
  }
  if (opts.deadlineSeconds && opts.deadlineSeconds > 0) {
    /*
     * The budget, and what to do about it.
     *
     * "Wrap up in time" alone is not actionable — a child that reads it and keeps gathering has
     * changed nothing. The instruction that matters is the fallback: hand in what you have. An
     * unfinished conclusion with its evidence beats a complete one that arrives after the kill.
     */
    lines.push(
      `- 时间预算：约 ${Math.round(opts.deadlineSeconds)} 秒，到点会被中止、什么都不会返回。`
      + '请据此安排：优先做能得出结论的部分，不要把所有时间花在收集上。'
      + '如果发现做不完，**提前**把已有结论和证据写进交付物交回来，'
      + '一份「做了一半、说清哪一半没做」的结果远好过一份赶不上的完整结果。',
    );
  }
  if (opts.isolated) {
    lines.push(
      '- 你在一个隔离副本里工作：你的改动不会自动进入主工作区。'
      + '正常完成即可，父智能体会按上面列出的路径取用结果 —— 不要尝试自己合并、提交或推送。',
    );
  }
  if (opts.kb === 'snapshot') {
    /*
     * The child owns the copy, and what it writes there comes back.
     *
     * Both halves matter and both were wrong before. Telling it that writes are discarded left it
     * deciding whether to spend a call on a note nobody would read; telling it nothing left the
     * parent absorbing an unreviewed edit. The rule is now a contract with a receiver: write the
     * reusable conclusions down — they are read once, at the end — and put the work product in the
     * deliverable, which is what actually reaches the parent's context.
     */
    lines.push(
      '- 你的知识库是**父级库的私有副本**：`kb_query` 查得到父级已知的东西，`kb_upsert` 也能写。'
      + '你写下的笔记会在你结束时被父级读一遍（副本随后删除），所以值得留的结论要写进去 —— '
      + '但要写**可复用的结论**（带依据、带路径/命令/数字），不要写过程流水：'
      + '父级只会看到每条笔记的标题和开头一段。交付物仍然是你交回答案的正路。',
    );
  } else if (opts.kb === 'shared') {
    /*
     * Sharing the parent's database is the case where the child can read history AND is one call
     * away from editing it permanently, so silence is the one thing the brief must not do. It is
     * read-only (see `KBToolOptions.readOnly`), and the reason is worth stating: a child that
     * understands its memory belongs to someone else stops looking for a way around the refusal.
     */
    lines.push(
      '- 你的知识库就是**父级的活动库**（`kb_query` 查得到父级已知的一切），但它对你是**只读**的：'
      + '`kb_upsert` / `kb_link` 会拒绝。重要结论写进交付物交回父级，由父级决定是否入库 —— '
      + '子任务直接写进去的记忆无法复核，事后也分不出是谁写的。',
    );
  } else if (opts.kb === 'empty') {
    lines.push(
      '- 你的知识库是**空的**（隔离副本里没有历史库文件）。`kb_query` 查不到任何东西是正常的，'
      + '**不要**据此说「这个项目没有相关记录」：历史事实以交接单和代码本身为准。',
    );
  }
  lines.push('', '## 任务', '', req.prompt.trim());
  return lines.join('\n');
}

export interface SubagentRunner {
  /**
   * Run one subtask to completion in isolation.
   *
   * Must NOT give the child the ability to delegate further — recursion here is
   * unbounded, and each level re-sends a full system prompt, so the cost grows
   * multiplicatively. Implementations are responsible for that guard.
   *
   * `hooks.progress` is optional and must be treated as best-effort: a reporter that throws, or
   * one nobody supplied, must never be able to fail or slow down the subtask it describes.
   */
  run(req: SubagentRequest, signal?: AbortSignal, hooks?: SubagentRunHooks): Promise<SubagentResult>;
}

/**
 * The channel a child has for saying "still working, and here is on what".
 *
 * Its audience is whoever is NOT blocked: the human watching the spinner, and the UI. The parent
 * agent cannot read it — it is suspended inside the tool call until that call returns — which is
 * why a timeout also has to leave a written trace (see `formatTimeoutReport`). These are the two
 * halves of the same answer to "a long subtask should not be a black box".
 */
export interface SubagentRunHooks {
  progress?: (event: {
    description: string;
    elapsedMs: number;
    steps: number;
    activity: string;
  }) => void;
}

/**
 * The delegation time budget, in one place.
 *
 * The default is the number the tool description quotes, and the clamp is what keeps a caller from
 * passing `timeout_ms: 86400000` and pinning the parent's turn for a day. The ceiling is high
 * enough for the heaviest honest job (a full test suite plus a build) and low enough that a
 * mis-typed zero cannot become an outage.
 */
export const DEFAULT_SUBAGENT_TIMEOUT_SECONDS = 180;
export const MIN_SUBAGENT_TIMEOUT_SECONDS = 30;
export const MAX_SUBAGENT_TIMEOUT_SECONDS = 30 * 60;

/**
 * 软截止：预算用到这个比例时，往子任务里插一句"停止探索、现在就交付"。
 *
 * 真实故障（2026-09-25 的 task_spawn）：子任务在第 90 秒就已经拿齐了交付物需要的事实
 * （四个符号都 grep 过、lsp_references 过），之后却把工作区里每个文件都读了一遍，直到
 * 180 秒被硬杀。交接单里写了期限，但模型在长推理里不会自己看表；硬杀之后只剩半截进度。
 * 所以在硬杀之前给它一次明确的收尾机会，剩下的时间足够再走一两步（那次每步约 40 秒）。
 */
export const SUBAGENT_WRAP_UP_RATIO = 0.7;

/**
 * 软截止是一段窗口，不是某一个时刻。
 *
 * 提醒要等一个回合边界才可能被看到——`interject` 只能排在工具调用和它的结果之后。2026-09-25
 * 那次超时留下的算术：提醒在 126.0s 发出，但子任务正等在一次 63.4s 的模型请求上，于是它 153.6s
 * 才落地，只剩 26.4s 给"最后一答"。同一轮里回合耗时的中位是 13.5s、最大 63.4s——那次赶上属于运气。
 *
 * 落晚了本来还可以补一次，但只有一发就没有下一次。所以窗口内排三次：第一次仍是原来的比例，
 * 后两次更晚、措辞点明是重复提醒。子任务按提醒交付了就结束，剩下的定时器随回合一起清掉；只有
 * 前一次落地后还在探索，才会用到后一次。
 */
export const SUBAGENT_WRAP_UP_RATIOS = [SUBAGENT_WRAP_UP_RATIO, 0.8, 0.88] as const;

/** 软截止在预算里的时刻（毫秒），即第一次提醒。导出以便测试。 */
export function subagentWrapUpDelayMs(budgetMs: number): number {
  return Math.round(budgetMs * SUBAGENT_WRAP_UP_RATIO);
}

/** 窗口内每次提醒的时刻（毫秒）：严格递增，且都早于硬截止。 */
export function subagentWrapUpScheduleMs(budgetMs: number): number[] {
  return SUBAGENT_WRAP_UP_RATIOS.map((r) => Math.round(budgetMs * r));
}

/**
 * 软截止时插进子任务的话。只说一件事：用手上已有的东西交付，不要再读新文件。
 *
 * `attempt` 大于 1 表示前一次提醒已经落地、子任务却还在花同一笔预算探索。这时不能再温和：
 * 剩下的时间只够一轮，它必须先交付。措辞要说清这一点，否则和第一次没区别。
 */
export function composeWrapUpNudge(remainingSeconds: number, attempt = 1): string {
  const s = Math.max(1, Math.round(remainingSeconds));
  const repeated = attempt > 1
    ? `这是第 ${attempt} 次提醒：上一次提醒之后你还在探索，而剩余时间只够一轮了。`
    : '';
  return `时间快到了：这个子任务还剩约 ${s} 秒就会被强制结束。停止继续探索，不要再读新文件或跑新的搜索。` +
    repeated +
    `现在就用你已经拿到的信息，按交接单的交付物格式给出最终答复；没查完的部分直接写明"未核实"。`;
}

/** Clamp a requested budget, or fall back to the default. Exported so the rule is testable. */
export function resolveSubagentTimeoutMs(requested: unknown, fallbackSeconds = DEFAULT_SUBAGENT_TIMEOUT_SECONDS): number {
  const fallback = fallbackSeconds * 1000;
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, MIN_SUBAGENT_TIMEOUT_SECONDS * 1000), MAX_SUBAGENT_TIMEOUT_SECONDS * 1000);
}

export interface SubagentProgressEvent {
  phase: 'start' | 'done' | 'heartbeat';
  description: string;
  ok?: boolean;
  /** heartbeat only: the reading from `readChildProgress`. */
  steps?: number;
  activity?: string;
  elapsedMs?: number;
}

export interface SubagentToolOptions {
  /** Called as each subtask starts, ticks, and finishes, so the UI can show progress. */
  onProgress?: (event: SubagentProgressEvent) => void;
}

export interface SubagentToolSet {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export function createSubagentTools(runner: SubagentRunner, opts?: SubagentToolOptions): SubagentToolSet {
  const definition: ToolDefinition = {
    name: 'task_spawn',
    description: [
      'Delegate self-contained subtasks to isolated child agents.',
      'Each child gets its OWN context (it cannot see this conversation) and returns only a summary.',
      'Use when a subtask is explorative or verbose — searching many files, gathering evidence —',
      'and you do not want the raw material in this transcript.',
      '',
      'The child cannot ask the user questions and cannot delegate further, so give it everything it needs.',
      'Fill in `deliverable` / `scope` / `constraints` rather than writing all of it into `prompt`:',
      'they are handed to the child as a structured brief and echoed back, so you can check afterwards',
      'whether it stayed in scope without re-reading what you asked for.',
      'Declare `scope` when the child is expected to EDIT files — that is what puts it in a private',
      'git worktree, so it cannot race you or its siblings on the same paths. A read-only child runs',
      'in this checkout and sees your uncommitted work.',
      'Prefer 1-2 focused subtasks over many; each one re-sends the full system prompt and costs accordingly.',
      '',
      'Each child writes into a PRIVATE copy of this workspace\'s knowledge base. When it ends, the notes it',
      'wrote are listed back to you (title + opening lines) and the copy is deleted — so telling a child to',
      'record reusable findings with `kb_upsert` is useful rather than pollution: it hands you notes to absorb',
      'with one call each, and you decide what goes into your own memory.',
      '',
      `Budget: each child is stopped after ${DEFAULT_SUBAGENT_TIMEOUT_SECONDS}s by default and returns NO result when that happens`,
      '(you get a report of what it had done so far, not its findings). That clock is spent mostly WAITING ON THE MODEL,',
      `not running tools: measured on this endpoint, ${DEFAULT_SUBAGENT_TIMEOUT_SECONDS}s is about six model turns, and a single`,
      'turn has been observed taking 60s+. So a task whose tools are instant still times out if it needs many turns —',
      'size `timeout_ms` by how many turns the task implies, not only by how big the files are, or pass `background: true`',
      'if you do not need the answer in this turn.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: 'Subtasks to run. Every item in the list runs; none are dropped for length.',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string', description: 'Short label (3-6 words).' },
              prompt: {
                type: 'string',
                description:
                  'Complete, self-contained instructions. Include the goal, what to inspect, ' +
                  'and exactly what to report back. The child has no access to this conversation.',
              },
              background: {
                type: 'boolean',
                description:
                  'True: start the child and return immediately. It keeps running as its own session ' +
                  '(listed under this conversation) instead of blocking this turn.',
              },
              deliverable: {
                type: 'string',
                description:
                  'One sentence naming what the child must produce — "a report listing every caller of X", ' +
                  '"a fix for the failing test in Y". Becomes the first line of its brief.',
              },
              scope: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Repo-relative paths the child may MODIFY. Listing any path gives it a private git ' +
                  'worktree. Omit for a read-only child.',
              },
              constraints: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Hard rules it must not break — "read-only", "no new dependencies", "do not touch package.json".',
              },
              context: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Facts you already established, so the child does not spend its budget re-deriving them.',
              },
              isolation: {
                type: 'string',
                enum: ['auto', 'worktree', 'none'],
                description:
                  "auto (default): a private worktree when `scope` is given, otherwise this checkout. " +
                  "worktree: force isolation. none: force sharing this checkout.",
              },
              timeout_ms: {
                type: 'number',
                description:
                  `How long this child may run, in milliseconds (default ${DEFAULT_SUBAGENT_TIMEOUT_SECONDS * 1000}). `
                  + `Clamped to ${MIN_SUBAGENT_TIMEOUT_SECONDS}s..${MAX_SUBAGENT_TIMEOUT_SECONDS / 60_000}min. `
                  + 'Set it for a task you expect to be heavy — a full build, a test suite, a wide search. '
                  + 'A child that hits the ceiling returns no findings, only a report of what it had done.',
              },
            },
            required: ['description', 'prompt'],
          },
        },
      },
      required: ['tasks'],
    },
  };

  const execute = async (_name: string, args: Record<string, unknown>): Promise<string> => {
    const raw = Array.isArray(args.tasks) ? args.tasks : [];
    const strList = (v: unknown): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const out = v.map((x) => String(x ?? '').trim()).filter(Boolean);
      return out.length ? out : undefined;
    };
    const tasks: SubagentRequest[] = raw
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        const handoff: SubagentHandoff = {
          deliverable: String(o.deliverable ?? '').trim() || undefined,
          scope: strList(o.scope),
          constraints: strList(o.constraints),
          context: strList(o.context),
        };
        const isolation: SubagentRequest['isolation'] =
          o.isolation === 'worktree' || o.isolation === 'none' ? o.isolation : 'auto';
        return {
          description: String(o.description ?? '').trim() || '(未命名子任务)',
          prompt: String(o.prompt ?? '').trim(),
          background: o.background === true,
          isolation,
          handoff: Object.values(handoff).some(Boolean) ? handoff : undefined,
          /*
           * Clamped, not rejected. A budget that is out of range is a caller saying "give it a
           * lot" or "keep it short", not an argument error worth a round-trip — and refusing would
           * turn a heavy task back into an unrunnable one, which is the bug this parameter exists
           * to fix.
           *
           * An ABSENT budget stays absent, rather than being filled in with the default here. The
           * default belongs to the runtime that enforces it: filling it in at this layer made the
           * runtime's own default unreachable — an operator's configured budget was silently
           * replaced by this constant, so the setting could not be lowered or raised at all.
           */
          timeoutMs: o.timeout_ms === undefined || o.timeout_ms === null
            ? undefined
            : resolveSubagentTimeoutMs(o.timeout_ms),
        };
      })
      .filter((t) => t.prompt);

    if (tasks.length === 0) return 'Error: no usable tasks (each needs a non-empty prompt)';

    /*
     * A task that edits files must say what it is producing.
     *
     * Refused here rather than sent on to the runner: the child would receive a worktree and an
     * open-ended "change whatever you like", which is the one shape of delegation that produces
     * work nobody can check. The parent gets a message telling it exactly what to add.
     */
    for (const t of tasks) {
      const writes = t.isolation === 'worktree' || (t.handoff?.scope?.length ?? 0) > 0;
      if (writes && !t.handoff?.deliverable) {
        return `Error: 子任务「${t.description}」会改动文件，但没有说明交付物（deliverable）。`
          + '补上它要产出什么（例如"修复 X 的失败测试"或"在 Y 里加 Z"），或者把 scope 去掉改成只读任务。';
      }
    }

    // Run concurrently: independent subtasks are exactly the case where waiting
    // in sequence wastes wall-clock time.
    const results = await Promise.all(
      tasks.map(async (t) => {
        opts?.onProgress?.({ phase: 'start', description: t.description });
        try {
          /*
           * The heartbeat is forwarded, not swallowed.
           *
           * The parent agent cannot read it — it is blocked in this tool call — but the human
           * watching a subtask that has run for two minutes can, and so can the task card. Passing
           * it through costs one callback and is the difference between "it is working" and "it is
           * hung" for everyone who is not the model.
           */
          const r = await runner.run(t, undefined, {
            progress: (p) => opts?.onProgress?.({
              phase: 'heartbeat',
              description: p.description,
              steps: p.steps,
              activity: p.activity,
              elapsedMs: p.elapsedMs,
            }),
          });
          opts?.onProgress?.({ phase: 'done', description: t.description, ok: r.ok });
          return r;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          opts?.onProgress?.({ phase: 'done', description: t.description, ok: false });
          return { description: t.description, ok: false, result: `子任务异常: ${msg}`, handoff: t.handoff };
        }
      }),
    );

    const lines: string[] = [`完成 ${results.length} 个子任务`, ''];
    for (const r of results) {
      lines.push(`### [${r.ok ? '完成' : '失败'}] ${r.description}`);
      const h = r.handoff;
      if (h?.deliverable) lines.push(`- 交付物：${h.deliverable}`);
      if (h?.scope?.length) lines.push(`- 允许改动：${h.scope.join('、')}`);
      if (h?.constraints?.length) lines.push(`- 约束：${h.constraints.join('；')}`);
      if (r.worktree) {
        lines.push(
          `- 隔离副本：${r.worktree.path}（分支 ${r.worktree.branch}）`,
        );
        lines.push(
          r.worktree.changed.length
            ? `- 改动的文件：${r.worktree.changed.join('、')}`
            : '- 改动的文件：无（副本与 HEAD 一致，也没有未提交改动）',
        );
        if (r.worktree.note) lines.push(`- 说明：${r.worktree.note}`);
      } else if (r.isolation?.note) {
        // No worktree and a note: the parent declared writable files, so the runtime was supposed to
        // put the child in a copy, and could not. Stated as its own line rather than appended to a
        // success block, because the parent has to change what it does next — its scope declaration
        // did not buy the guarantee it asked for.
        lines.push(`- ⚠ 未隔离：${r.isolation.note}`);
      }
      lines.push('');
      lines.push(r.result.trim());
      if (r.kbHarvest) {
        const harvest = renderKbHarvest(r.kbHarvest);
        if (harvest.length) {
          lines.push('');
          lines.push(...harvest);
        }
      }
      lines.push('');
    }
    lines.push(
      '以上是子智能体返回的摘要。原始过程没有进入本对话；如需细节请再指派。'
      + '若有隔离副本，它的改动还在副本里，需要时按上面的路径取用。',
    );
    return lines.join('\n');
  };

  return { definitions: [definition], execute };
}
