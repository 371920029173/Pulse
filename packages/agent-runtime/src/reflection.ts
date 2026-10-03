/**
 * Reflection: three checks that are about the AGENT rather than about the task.
 *
 *   - **Drift** (语义漂移检测) — the goal was stated once, at the start. Every action since has been
 *     chosen by a step that was already one step away from it, and a task can walk a long way from
 *     its own goal without any single step looking wrong. `detectDrift` compares the goal, the
 *     constraints and the actions, and says when the thread has been lost.
 *   - **Confidence mirror** (置信度镜像) — a stated confidence is a claim, and the tool trace is the
 *     measurement. `ConfidenceMirror` keeps the two side by side until a bias is visible, because a
 *     model that says "0.9" every time and is right 0.6 of the time is not slightly wrong: its
 *     numbers stop carrying information, and everything downstream that trusts them is wrong too.
 *   - **Reflections into the error book** (事后反思写入错题本) — `deriveReflections` turns the two
 *     reports above, plus what actually failed, into the same kind of note the error book already
 *     holds for tool failures. What is written is a LESSON, not a log line: the book is read before
 *     similar work starts, so an entry that only says what happened costs attention and returns
 *     nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE DRIFT CHECK IS LEXICAL, AND WHICH WAY IT IS ALLOWED TO BE WRONG
 *
 * A deterministic layer cannot understand whether `git push` serves "fix the login bug" — that is
 * judgement, and it belongs to the model. What it CAN do is notice that the last five actions
 * contain no word from the goal, which is a fact about the text and a real signal: on-task work
 * almost always names the thing it is working on.
 *
 * So the thresholds are set to fire late and to over-report drift rather than under-report it. A
 * false alarm costs one glance at the goal, which the check then makes the agent take — that is the
 * cheap direction to be wrong in. A missed drift costs the whole task, because nothing else in the
 * system is watching for it.
 *
 * The exception is constraints. A stated rule like "do not touch the migration files" is not a
 * judgement call, and touching one IS a violation — so that signal is major, and it fires on
 * evidence (the excluded object appears in an action) rather than on a score.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sessionStateDir } from './session-state.js';
import type { Constraint } from './preflight.js';
import { isWorthRemembering } from './errorbook.js';

// ─── Word extraction ────────────────────────────────────────────────────────

/**
 * Words that carry no subject matter.
 *
 * Deliberately generous on the Chinese side: the CJK bigrams below are generated mechanically, so
 * any run of two characters becomes a "term" — including the structural glue in "不要修改 X 里的
 * Y". Those have to be filtered here, or a constraint's excluded OBJECT would come out as "里的".
 */
const GENERIC = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'code', 'file', 'files', 'test', 'tests',
  'true', 'false', 'null', 'run', 'use', 'using', 'add', 'make', 'new', 'old', 'not', 'but',
  '一个', '这个', '那个', '我们', '你们', '他们', '以及', '并且', '如果', '所以', '但是', '然后',
  '可以', '需要', '应该', '必须', '可能', '已经', '还是', '或者', '因为', '这样', '那样', '就是',
  '里的', '里面', '那个', '相关', '任何', '部分', '东西', '事情', '时候', '现在', '一下',
  '改动', '修改', '变更', '触碰', '删除', '使用', '执行', '运行', '调用', '其它', '其他', '别的',
  '这些', '那些', '不能', '不要', '不得', '禁止', '严禁', '避免', '不准',
]);

/**
 * The subject matter of a piece of text: ASCII words and CJK bigrams.
 *
 * Bigrams rather than whole CJK runs because a goal is short — "修复登录超时" is four characters and
 * one word to a human, and comparing it as a single token would only match a verbatim copy. As two
 * bigrams ("修复", "复登", "登录", "录超", "超时") the same phrase overlaps with any sentence that
 * mentions "登录" or "超时", which is the behaviour a drift check needs. The junk bigrams dilute but
 * never fabricate: a term only counts when it is literally present in the other text.
 */
export function goalTerms(text: string): string[] {
  const found: string[] = [];
  const push = (t: string) => {
    if (!GENERIC.has(t) && !found.includes(t)) found.push(t);
  };
  const raw = String(text ?? '').toLowerCase();
  for (const m of raw.matchAll(/[a-z0-9_@./\\:-]{3,}/g)) push(m[0].replace(/^[./\\:-]+|[./\\:-]+$/g, ''));
  for (const m of raw.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i + 2 <= run.length; i++) push(run.slice(i, i + 2));
  }
  return found.filter((t) => t.length >= 2);
}

/*
 * Both sides lowercased. The text always was, the terms were not: goal terms come in lowercased, but a
 * prohibition object is kept as written, so 「不要改 README.md」 could never match a call writing
 * README.md (reviewer, round 3). Path separators are folded too (`packages\migrations` in a cmd.exe
 * command, JSON-escaped, is `packages/migrations`). The term is returned as written, for the report.
 */
function containsAny(text: string, terms: string[]): string | null {
  const norm = (x: unknown) => String(x ?? '').toLowerCase().replace(/\\+/g, '/');
  const hay = norm(text);
  for (const t of terms) if (hay.includes(norm(t))) return t;
  return null;
}

// ─── Drift ──────────────────────────────────────────────────────────────────

export type DriftLevel = 'none' | 'watch' | 'drift';

export type DriftSignalKind =
  /** An action touched something a constraint explicitly excluded. */
  | 'constraint_violated'
  /** The last few actions contain no word from the goal — the thread may be lost. */
  | 'goal_unrelated'
  /** The plan step being worked on does not mention the goal either. */
  | 'step_off_goal'
  /** The step budget is spent. Continuing is drift by definition. */
  | 'budget_overrun';

export interface DriftSignal {
  kind: DriftSignalKind;
  /** A major signal makes the level `drift` on its own; everything else has to accumulate. */
  major: boolean;
  weight: number;
  /** What was observed, in the terms the check used. No conclusions. */
  detail: string;
}

/** One action to check. `args` and `summary` are both searched; either may be absent. */
export interface DriftAction {
  tool: string;
  summary?: string;
  args?: string;
}

export interface DriftInput {
  /** The goal as pre-flight recorded it. Not the current step — that is the thing under test. */
  goal: string;
  /** Constraints to check against. A bare string is treated as a hard rule. */
  constraints?: (string | { text: string; hardness?: 'hard' | 'soft' })[];
  /** Actions taken so far, oldest first. */
  actions?: (DriftAction | string)[];
  /** The plan step currently being worked on, if there is a plan. */
  currentStep?: string | null;
  stepsUsed?: number;
  stepBudget?: number;
  /**
   * The agent's registered tool names. An object that is a tool name is compared with the tool that
   * was CALLED, never with arguments ("不要用 shell" is not broken by `fs_read src/shell/index.ts`).
   * Omitted: the built-in list (`isKnownToolName`). The run's own calls are always added.
   */
  toolNames?: string[];
}

export interface DriftReport {
  level: DriftLevel;
  score: number;
  signals: DriftSignal[];
  /** What to do about it, or null when there is nothing to do. */
  advice: string | null;
  /** True when the report is telling the caller to stop and re-plan. */
  replan: boolean;
}

/**
 * Words that make a constraint a PROHIBITION rather than a description.
 *
 * Only prohibitions are checked, and the asymmetry is on purpose: "the config is JSON" is a
 * constraint too, but violating it is a bug in the work, which the tests and the diagnostics will
 * find. "Do not touch the migrations" is a constraint where nothing else will notice, and where
 * noticing afterwards is too late.
 */
/*
 * Colloquial forms count too (reviewer, after R7): "别用 fs_write" and "勿用 X" were not prohibitions at
 * all, so calling X was never flagged. "别" only together with a verb — on its own it is also "别的"
 * (other), and "用别的工具" must stay a permission.
 */
const PROHIBITION = /(不要|不得|不准|不许|禁止|严禁|避免|别去|别动|别改|不可以|不能|千万别|别(?:用|使用|调用|碰|再|跑|执行|运行|删|写|读|直接|乱|装|提交|推)|勿|不允许|禁用|do\s+not|don'?t|never|avoid|must\s+not|should\s+not|cannot|can'?t|mustn'?t|shouldn'?t|may\s+not|refrain\s+from|stop\s+using)/i;

/**
 * Words that introduce an EXCEPTION to a prohibition, i.e. something the constraint permits.
 *
 * Why this exists: a constraint is one sentence, and the half that says what is ALLOWED used to be
 * read as if it said what is forbidden. Measured on a live run, the constraint
 *
 *   「只读」限定在文件/命令层面：子代理不得用 shell、fs_*、git 等工具，不得修改工作区；
 *   唯一被点名的写入是 kb_upsert 写知识库（用户明确指定的例外）。
 *
 * was reported as violated by the agent's own `kb_upsert` — the call the constraint had just
 * carved out. The accusation was major (weight 0.8), so it drove the turn to `drift` and was
 * written into the error book as a lesson. The failure mode is self-inflicted noise of the worst
 * kind: the more carefully a constraint names its exception, the more reliably the check fires on
 * the permitted action — and a check whose accusations cannot be trusted is one the agent learns
 * to skip wholesale.
 */
const EXCEPTION = /^(只(?:用|能用|使用|许用|准用|走|通过|调用)|仅(?:用|使用|通过)|use\s+only|例外|除外|唯一|除[^，。；]{0,12}外|允许|可以|不受|仅限|only|except|unless)/i;

/**
 * Where a WHITELIST starts inside a clause: "只用 kb_* 工具", "仅通过 X", "only use X".
 *
 * A whitelist names what IS allowed, so it is the permitted half of the constraint, the same as an
 * exception. Measured on a live run, the constraint
 *
 *   不得直读 .she/kb.sqlite，只用 kb_* 工具
 *
 * was reported as violated six times by the agent's own `kb_upsert`: "只用" was not an exception
 * marker, so the whitelist stayed in the prohibition and `kb_` became the forbidden object. The more
 * obediently the agent used the named tools, the more often it was accused. Used both as an
 * exception marker (see `EXCEPTION`) and as a split point, so "不得直读 X 只用 Y" without a comma
 * is read the same way.
 */
const WHITELIST_START = /(?=只(?:用|能用|使用|许用|准用|走|通过|调用)|仅(?:用|使用|通过)|\buse\s+only\b|\bonly\s+use\b)/i;

/**
 * A constraint that NAMES A TOOL in order to prescribe it: "用 shell 跑测试", "改用 fs_patch",
 * "must call kb_query first", "run git via shell", "shell 是唯一可用的工具".
 *
 * Measured (tester round R7, rate 1.00): the model writes its constraints as one sentence that
 * mixes what to use with what to avoid — 「用 shell 跑测试，不要用 fs_write」 — and a clause that
 * is neither a prohibition nor an "只用/仅通过" whitelist was glued onto the prohibition (a comma
 * alone does not end a clause, so lists survive). The tool it prescribed then became one of the
 * two "forbidden" objects, and every obedient call to it was reported as a hard violation.
 *
 * So a clause with no prohibition and no negation that opens with a use-verb aimed at something
 * code-like (an ASCII name or a quoted span), or that says what is the only / allowed choice, is
 * the PERMITTED half, read like an exception. A use-verb has to be followed by a name: "用户配置",
 * "调用方的代码" are nouns, not instructions, and stay in the prohibition as before.
 */
const NEGATION = /(不|别|勿|没|无|非|莫|未|\bnot\b|n't\b|\bcannot\b|\bno\b|\bnever\b|\bwithout\b)/i;
const NAME_AHEAD = String.raw`(?=\s*[\x60"'“「A-Za-z_./])`;
const PERMISSION: RegExp[] = [
  // 用 shell / 先用 kb_query / 必须先调用 kb_query / 通过 shell / 改用 fs_patch / 跑 pnpm test
  new RegExp(String.raw`^(?:请|要|需要?|必须|务必|应该?|应当|一律|统一|全部|都|就|则|还|也|并且?|而且?|而是?|然后|之后|随后|再|先|优先)*\s*`
    + String.raw`(?:使用|调用|通过|经由|借助|采用|运行|执行|(?:改|换|转)?(?:用|走|跑))` + NAME_AHEAD),
  // 测试用 shell 跑 / git 通过 shell 执行
  // (费用 API / 应用 X / 作用 are nouns: their 用 is not "use")
  new RegExp(String.raw`^[^，,；;。]{0,12}?(?<![不别勿没无非莫未费作信应有通适引占享专备常惯启录雇实运公])(?:用|使用|调用|通过|经由|借助)` + NAME_AHEAD),
  // use shell / must call kb_query first / instead use fs_patch / run git via shell
  /^(?:(?:and|then|but|instead|so|please|always|first|also|just)\s*,?\s+)*(?:(?:you|we)\s+)?(?:(?:must|should|shall|need\s+to|needs\s+to|have\s+to|has\s+to|always|first|to)\s+)*(?:use|call|invoke|run|prefer|go\s+(?:through|via)|via|through|switch\s+to|stick\s+(?:to|with)|rely\s+on|instead)\b/i,
  // tests run via shell
  /^[^,;.]{0,30}?\b(?:via|through)\s+[`"'A-Za-z_]/i,
  // shell 是唯一可用的工具 / shell is the only tool allowed
  /(唯一|只能|只允许|只许|仅限|仅允许|允许|可以用|可用|\bonly\b|\ballowed\b|\bpermitted\b)/i,
];

/** True for a clause that only prescribes or permits: see `PERMISSION`. */
function isPermission(piece: string): boolean {
  if (PROHIBITION.test(piece) || NEGATION.test(piece)) return false;
  return PERMISSION.some((re) => re.test(piece.trim()));
}

/**
 * Where a SUBSTITUTE starts inside a clause: "不要用 fs_write 改用 fs_patch", "never use fs_write
 * but use fs_patch". What follows is what to use instead, the same as a whitelist. The CJK forms
 * need a name after them for the same reason as `PERMISSION`: "修改用户配置" contains "改用".
 */
const SUBSTITUTE_START = new RegExp(
  String.raw`(?=(?:改|换|转|而是?)用` + NAME_AHEAD + String.raw`|\binstead\s+(?:use|call|run|invoke|go)\b|\bbut\s+(?:use|call|run|invoke|go)\b)`,
  'i',
);

/**
 * "用 shell 跑测试并且不要用 fs_write": a prescription and a prohibition with no punctuation between
 * them. Split at the prohibition word, but only when the head before it is itself a permission —
 * "子代理不得用 shell" has a head ("子代理") that is not, and is left whole.
 */
function splitPermissionHead(piece: string): string[] {
  const at = piece.search(PROHIBITION);
  if (at <= 0) return [piece];
  const head = piece.slice(0, at);
  return isPermission(head) ? [head, piece.slice(at)] : [piece];
}

/**
 * A constraint cut into the pieces `analyzeConstraint` classifies, one statement or half-statement
 * each. A colon ends a piece too ("shell 为 Windows cmd：无 cat/which"): what precedes it is a
 * heading or a description. Only a full-width colon or one followed by a space, so "D:\\x" survives.
 */
function constraintPieces(text: string): string[] {
  return String(text ?? '').split(/[，,；;。!！?？\n]+|：|:\s+/)
    .flatMap((p) => p.split(WHITELIST_START))
    .flatMap((p) => p.split(SUBSTITUTE_START))
    .flatMap(splitPermissionHead);
}

/**
 * The parts of a constraint that name what to USE or what is REQUIRED/exempt: the exception,
 * whitelist and permission clauses, and the required spans below. Exported for the error-book
 * migration, which retires accusations whose object came from one of these parts.
 */
export function permittedParts(text: string): string[] {
  const t = String(text ?? '').replace(PROVENANCE, ' ');
  return [...analyzeConstraint(t).permitted, ...requiredSpans(t)];
}

/**
 * The parts of a constraint read as CONTEXT rather than as what it forbids: the subject or
 * description in front of a prohibition that names its own object ("shell 由 cmd.exe 解析，不能用
 * POSIX 写法" — the prohibition is about POSIX syntax; `shell` is what is being described).
 * Exported for the error-book migration, like `permittedParts`.
 */
export function contextParts(text: string, isTool?: (name: string) => boolean): string[] {
  return objectAnalysis(text, isTool).context;
}

function requiredSpans(text: string): string[] {
  const out: string[] = [];
  for (const re of REQUIRED_SPANS) for (const m of String(text ?? '').matchAll(re)) out.push(m[0].trim());
  return out;
}

/**
 * Spans INSIDE a prohibition that name what is required or exempt rather than what is forbidden:
 * "不要跳过 kb_query", "do not edit files without calling kb_query first", "除 shell 外不要用其他
 * 工具", "never use any tool other than shell", "在调用 kb_query 之前不要写文件".
 *
 * Measured with the same R7 phrasings: the named tool is the most concrete token in the sentence,
 * so it won the "longest two candidates" race and calling it — the very thing the rule demands —
 * was reported as the violation. The span is removed before objects are picked; what remains
 * (the thing that must not happen) is still checked.
 */
const NAMED = String.raw`(?:\x60[^\x60]+\x60|"[^"]+"|“[^”]+”|[A-Za-z0-9_@./\\:*-]+)`;
const REQUIRED_SPANS: RegExp[] = [
  new RegExp(String.raw`(?:跳过|略过|绕过|绕开|忘记|忘了|漏掉|漏了|遗漏|省略|省掉)\s*(?:先|去)?(?:调用|使用|用|跑|运行|执行)?\s*(?:${NAMED}|[\u4e00-\u9fff]{1,4})`, 'g'),
  new RegExp(String.raw`(?:(?:未|没有?)先?(?:调用|使用|用|跑|运行|执行|查询?)|不先(?:调用|使用|用|跑|运行|执行|查询?)?)\s*${NAMED}`, 'g'),
  new RegExp(String.raw`(?:在)?(?:先)?(?:调用|使用|用|跑|运行|执行)\s*${NAMED}\s*(?:之前|以前|前)`, 'g'),
  // 除 inside 删除/排除/清除... is not "except": "不要用 shell 删除 packages/migrations" keeps its object.
  new RegExp(String.raw`(?<![删排消清解去免剔废拆扣开切革摘移整破初])除了?\s*(?:${NAMED}(?:\s*(?:之外|以外|外))?|[\u4e00-\u9fff]{1,6}?(?:之外|以外|外))`, 'g'),
  new RegExp(String.raw`${NAMED}\s*(?:之外|以外)的?`, 'g'),
  new RegExp(String.raw`\b(?:skip(?:ping)?|bypass(?:ing)?|omit(?:ting)?|forget(?:ting)?(?:\s+to)?|without(?:\s+first)?|before(?:\s+first)?|until|unless|except(?:\s+(?:for|via|through|with))?|other\s+than|besides|apart\s+from|aside\s+from|anything\s+but|instead\s+of)\s+`
    + String.raw`(?:(?:calling|using|running|checking|consulting|invoking|call|use|run|check|consult|invoke)\s+)?(?:the\s+)?${NAMED}(?:\s+(?:tool|tools|command))?`, 'gi'),
];

/**
 * English glue that is never the object of a prohibition. Without it, "never call the git tool"
 * yields `call`/`tool` (four letters beat `git`'s three), and "never read X directly" yields `read`,
 * which then matches every `fs_read`. Object picking only; goal terms are unaffected.
 */
const OBJECT_STOP = new Set([
  'any', 'all', 'other', 'than', 'tool', 'tools', 'first', 'then', 'instead', 'directly', 'only',
  'via', 'through', 'call', 'calling', 'before', 'after', 'without', 'when', 'them', 'else',
  'anything', 'something', 'every', 'each', 'just', 'also', 'ever', 'read', 'write', 'edit', 'touch',
  'modify', 'change', 'delete', 'remove', 'access',
]);

/**
 * COMMAND objects: "不要用 rm -rf", "never run git push --force", "不要 npm publish".
 *
 * Measured by the reviewer (round 3): an un-backticked command was cut into words and the two longest
 * kept, so 「不要用 rm -rf」 had the objects `rm`-less `rf` and nothing that matched `rm -rf x`, while
 * 「不要 git push --force」 had `push` and `force` matched separately, and `git push origin main` was
 * reported as the forbidden force push. A command phrase is now one object: a command word followed by
 * its subcommand and flags, kept whole, and matched against a call as a command (`commandMatches`).
 *
 * A phrase is a known command word (or any word followed directly by a flag) plus what follows it up to
 * the first piece of English glue ("on", "via", "to"...) or the end of the ASCII run. It needs a flag,
 * or a command whose next word is a subcommand (git push, npm publish, docker system prune): "never
 * cat files" stays the words it was.
 */
const KNOWN_COMMANDS = new Set([
  'git', 'rm', 'rmdir', 'rd', 'del', 'erase', 'mv', 'cp', 'dd', 'mkfs', 'chmod', 'chown', 'chgrp', 'sudo',
  // portability-check:allow — 这是**命令名清单**（用来把约束原句拆成命令短语），不是调用；这里没有分支可加。
  'kill', 'pkill', 'killall', 'taskkill', 'shutdown', 'reboot', 'format', 'npm', 'pnpm', 'yarn', 'npx', 'bun',
  'deno', 'node', 'python', 'python3', 'py', 'pip', 'pip3', 'uv', 'poetry', 'docker', 'podman', 'kubectl',
  'helm', 'terraform', 'curl', 'wget', 'ssh', 'scp', 'rsync', 'make', 'cargo', 'go', 'mvn', 'gradle', 'sed',
  'awk', 'find', 'xargs', 'tar', 'unzip', 'reg', 'sc', 'net', 'netsh', 'powershell', 'pwsh', 'cmd', 'bash',
  'sh', 'sqlite3', 'psql', 'mysql', 'robocopy', 'xcopy', 'move', 'copy', 'icacls', 'attrib', 'ls', 'cat',
  'echo', 'touch', 'mkdir', 'truncate',
]);
/** Commands whose next word is a subcommand, so "git push" is a command phrase without a flag. */
const SUBCOMMAND_COMMANDS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'docker', 'podman', 'kubectl', 'helm', 'terraform', 'cargo',
  'pip', 'pip3', 'uv', 'poetry', 'mvn', 'gradle',
]);
/** Words that end a command phrase in a sentence ("never run rm -rf ON the repo"). */
const COMMAND_GLUE = new Set([
  'on', 'in', 'into', 'to', 'at', 'for', 'the', 'a', 'an', 'and', 'or', 'with', 'without', 'when', 'unless',
  'if', 'from', 'of', 'by', 'via', 'through', 'against', 'inside', 'under', 'as', 'instead', 'but', 'then',
  'please', 'anything', 'anymore', 'again', 'ever', 'directly', 'while', 'any', 'it', 'this', 'that', 'these',
  'those', 'here', 'there', 'because', 'so', 'is', 'are', 'be', 'anywhere', 'except', 'before', 'after',
]);
/** Verbs in front of a command ("never RUN rm -rf"): never the command word. */
const COMMAND_VERBS = new Set(['use', 'run', 'call', 'execute', 'exec', 'invoke', 'type', 'try', 'do', 'using', 'running']);
/** --force ~ -f, --recursive ~ -r: the two aliases that matter for the destructive commands people forbid. */
const FLAG_ALIAS: Record<string, string> = { force: 'f', recursive: 'r' };

function isFlagToken(t: string): boolean {
  return /^--?[a-z0-9][a-z0-9-]*(?:=.*)?$/i.test(t) || /^\/[a-z?]{1,2}$/i.test(t);
}
function commandToken(t: string): string {
  return String(t ?? '').toLowerCase().replace(/^[`"']+|[`"']+$/g, '').replace(/^\.\/(?=.)/, '').replace(/(?<=.)[\\/]+$/, '');
}
function commandBase(t: string): string {
  return (t.split(/[\\/]/).pop() ?? t).replace(/\.(?:exe|cmd|bat)$/, '');
}

/** True when an object reads as a command line ("rm -rf", "git push --force"), quoted or not. */
function isCommandPhrase(object: string, isTool: (name: string) => boolean = () => false): boolean {
  const toks = String(object ?? '').trim().split(/\s+/).map(commandToken).filter(Boolean);
  if (toks.length < 2) return false;
  const cmd = commandBase(toks[0]);
  if (!/^[a-z][a-z0-9_.+-]*$/.test(cmd) || isTool(cmd)) return false;
  return toks.slice(1).some(isFlagToken) || KNOWN_COMMANDS.has(cmd);
}

/** The command phrases in a piece of prohibition text, and the text with them taken out. */
function commandsIn(text: string, isTool: (name: string) => boolean): { commands: string[]; rest: string } {
  const commands: string[] = [];
  let rest = text;
  for (const m of text.matchAll(/[A-Za-z0-9_@./\\:*=+~-]+(?:[ \t]+[A-Za-z0-9_@./\\:*=+~-]+)*/g)) {
    const toks = m[0].split(/\s+/);
    let i = 0;
    while (i < toks.length) {
      const lt = toks[i].toLowerCase();
      const next = (toks[i + 1] ?? '').toLowerCase();
      const start = !COMMAND_VERBS.has(lt) && !COMMAND_GLUE.has(lt) && !isTool(lt) && (KNOWN_COMMANDS.has(lt)
        || (/^--?[a-z]/.test(next) && isFlagToken(next) && /^[a-z][a-z0-9_.-]*$/.test(lt) && !GENERIC.has(lt) && !OBJECT_STOP.has(lt)));
      if (!start) { i++; continue; }
      let j = i + 1;
      while (j < toks.length && !COMMAND_GLUE.has(toks[j].toLowerCase()) && !isTool(toks[j].toLowerCase())) j++;
      const phrase = toks.slice(i, j);
      const valid = phrase.length >= 2 && (phrase.slice(1).some(isFlagToken)
        || (SUBCOMMAND_COMMANDS.has(lt) && /^[a-z][a-z0-9-]*$/.test(phrase[1].toLowerCase())));
      if (!valid) { i++; continue; }
      commands.push(phrase.join(' '));
      rest = rest.replace(phrase.join(' '), ' ');
      i = j;
    }
  }
  return { commands, rest };
}

/** The flags of a command line: long names and short letters, aliases folded in. */
function flagSet(tokens: string[]): { long: Set<string>; short: Set<string> } {
  const long = new Set<string>();
  const short = new Set<string>();
  for (const t of tokens) {
    if (t.startsWith('--')) {
      const name = t.slice(2).split('=')[0];
      long.add(name);
      if (FLAG_ALIAS[name]) short.add(FLAG_ALIAS[name]);
    } else if (/^-[a-z0-9]+$/.test(t)) {
      for (const ch of t.slice(1)) short.add(ch);
    } else {
      long.add(t);
    }
  }
  return { long, short };
}

/**
 * Does `text` (a call's target) run the command `phrase`? Within ONE command segment (split at `&&`,
 * `||`, `;`, `|`, newlines and JSON string boundaries): the command word, then the phrase's other words
 * in order (more arguments may sit between them), and every flag the phrase names, in any order and
 * spelled as the phrase spells it or as its alias (`--force` / `-f`, `-rf` / `-r -f` / `--recursive
 * --force`). So `git push origin main` is not `git push --force`, `git push --force-with-lease` is not
 * either, and `git push origin --force` is.
 */
export function commandMatches(text: string, phrase: string): boolean {
  const want = String(phrase ?? '').trim().split(/\s+/).map(commandToken).filter(Boolean);
  if (want.length < 1) return false;
  const cmd = commandBase(want[0]);
  const words = want.slice(1).filter((t) => !isFlagToken(t));
  const flags = flagSet(want.slice(1).filter(isFlagToken));
  for (const seg of String(text ?? '').toLowerCase().split(/&&|\|\||[;|\n"]|\\[nr"]/)) {
    const toks = seg.trim().split(/\s+/).map(commandToken).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      if (commandBase(toks[i]) !== cmd) continue;
      const rest = toks.slice(i + 1);
      let k = 0;
      for (const w of rest.filter((t) => !isFlagToken(t))) if (k < words.length && w === words[k]) k++;
      if (k < words.length) continue;
      const have = flagSet(rest.filter(isFlagToken));
      const longOk = [...flags.long].every((n) => have.long.has(n) || (FLAG_ALIAS[n] !== undefined && have.short.has(FLAG_ALIAS[n])));
      const shortOk = [...flags.short].every((c) => have.short.has(c));
      if (longOk && shortOk) return true;
    }
  }
  return false;
}

/** Is the object `o` in the call's target? A command phrase as a command, anything else as a substring. */
function objectInTarget(text: string, o: string, isTool: (name: string) => boolean): boolean {
  return isCommandPhrase(o, isTool) ? commandMatches(text, o) : containsAny(text, [o]) !== null;
}

/**
 * "X 的 Y" / "X's Y" / "Y of X" with X a TOOL: the prohibition is about Y, and X is context.
 * 「不要用 shell 的 POSIX 写法」 forbids POSIX syntax, not shell (reviewer, round 3: `shell dir` was
 * flagged). Only for tools: "cluster.ts 的导出" is still about cluster.ts, since changing a file's exports
 * is changing the file.
 */
function stripToolPossessive(text: string, isTool: (name: string) => boolean): string {
  const drop = (whole: string, name: string) => (isTool(name.toLowerCase()) ? ' ' : whole);
  return text
    .replace(/[`"']?([A-Za-z][A-Za-z0-9_*]*)[`"']?\s*(?:工具)?\s*的(?=\s*\S)/g, drop)
    .replace(/[`"']?\b([A-Za-z][A-Za-z0-9_*]*)[`"']?'s\b/g, drop)
    .replace(/\bof\s+(?:the\s+)?[`"']?([A-Za-z][A-Za-z0-9_*]*)[`"']?(?:\s+tool)?\b/gi, drop);
}

/**
 * A prohibition that names a tool AND what it must not be used on: "do not use fs_write on .git",
 * 「不要用 fs_write 改 README.md」, 「不要在 .git 里用 fs_write」, 「不要用 shell 删除 X」, "never touch
 * .git with fs_write". The tool is the instrument, not the forbidden thing: measured by the reviewer
 * (round 3), `fs_write src/a.ts` was reported under "do not use fs_write on .git" because tool and object
 * were matched independently. In such a statement the tool is context and only the object is matched
 * (see `objectAnalysis`).
 */
const TOOLISH = String.raw`[\x60"']?[A-Za-z][A-Za-z0-9_*]*[\x60"']?`;
const SCOPE: RegExp[] = [
  new RegExp(String.raw`\b(?:use|call|run|invoke|using|calling)\s+(?:the\s+)?${TOOLISH}(?:\s+tool)?\s+(?:on|in|into|to|against|inside|under|within|for)\s+\S`, 'i'),
  new RegExp(String.raw`\b(?:with|using|via)\s+(?:the\s+)?${TOOLISH}(?:\s+tool)?(?:\s|$)`, 'i'),
  new RegExp(String.raw`(?:用|使用|调用|通过)\s*${TOOLISH}\s*(?:工具)?\s*(?:来|去)?\s*(?:对|给|往|向|在|把)?[^，,；;。]*?(?:改|写|删|修改|编辑|创建|覆盖|删除|动|碰|重写|写入|改动|操作|处理|读|打开|访问|执行|运行|跑|清理|清空|提交|推)`),
  new RegExp(String.raw`在\s*[^，,；;。]{1,40}?(?:里|中|下|内|上)\s*(?:用|使用|调用|跑|运行|执行)\s*${TOOLISH}`),
];

/**
 * Objects the constraint names AS A TOOL ("the git tool", "`git` 等工具", "kb_* tools"). Matched
 * against the tool that was called, not its arguments: "never call the git tool" forbids that tool,
 * not a `shell` call whose command line happens to start with `git`.
 */
function toolNamedObjects(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(/[`"']?([A-Za-z0-9_*.-]{2,})[`"']?\s*(?:等)?\s*(?:tools?\b|工具)/gi)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

/**
 * Does a call to `tool` count as using `object`, an object that names a tool? The tool itself or its
 * family ("shell" covers `shell_wait`, "git" covers `git_status`), or a prefix glob ("kb_*", "fs_").
 */
export function toolNameMatches(tool: string, object: string): boolean {
  const t = String(tool ?? '').toLowerCase();
  const o = String(object ?? '').toLowerCase();
  const core = o.replace(/\*+$/, '');
  if (core.length < 2 || !t) return false;
  if (o.endsWith('*') || core.endsWith('_')) return t.startsWith(core);
  return t === core || t.startsWith(`${core}_`);
}

/**
 * Tool names the runtime registers, for when the caller does not pass its own list (the error-book
 * migration, offline checks). `detectDrift` prefers `DriftInput.toolNames` — the agent passes its
 * real tool table, MCP tools included — and always adds the tools the run actually called.
 */
const BUILTIN_TOOL_NAMES = [
  'shell', 'shell_wait', 'shell_jobs', 'shell_kill', 'fs_read', 'fs_write', 'fs_list', 'grep',
  'git_status', 'git_diff', 'git_log', 'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_diagnostics',
  'kb_query', 'kb_get', 'kb_upsert', 'kb_edit', 'kb_link', 'kb_retire', 'kb_ingest_scan', 'kb_ingest_list',
  'kb_ingest_place', 'kb_ingest_status', 'plan_create', 'plan_get', 'plan_list', 'plan_update', 'plan_add_steps',
  'memo_add', 'memo_list', 'memo_update', 'memo_remove', 'errorbook_lookup', 'errorbook_forget',
  'preflight_record', 'reflection_check', 'report_write', 'task_spawn', 'ask_user', 'schedule_create',
  'schedule_list', 'schedule_cancel', 'schedule_window', 'screenshot', 'vision_describe',
  'web_search', 'web_fetch',
  'computer_click', 'computer_type', 'computer_key', 'computer_scroll',
];
/** The runtime's tool families: `fs_*`, `kb_*`, `mcp_*`… A name of this shape is a tool name. */
const TOOL_FAMILY = /^(?:fs|kb|plan|lsp|git|shell|memo|schedule|computer|errorbook|reflection|preflight|task|report|vision|web|mcp|skill)_[a-z0-9_]*\*?$/;

/** True when `name` is a tool name: registered (or built in), a glob over one, or of a tool family's shape. */
export function isKnownToolName(name: string, registered?: Iterable<string>): boolean {
  const o = String(name ?? '').toLowerCase().replace(/^[`"']|[`"']$/g, '');
  const core = o.replace(/\*+$/, '');
  if (core.length < 2) return false;
  const known = registered ? [...registered].map((n) => n.toLowerCase()) : BUILTIN_TOOL_NAMES;
  if (known.includes(core)) return true;
  if ((o.endsWith('*') || core.endsWith('_')) && known.some((k) => k.startsWith(core))) return true;
  return TOOL_FAMILY.test(o);
}

/**
 * "Every OTHER tool is forbidden": 别的/其他/其它/其余（工具）, X 以外/之外的工具, other tools, any
 * other, other than, anything else. Together with a prohibition it turns the tools the constraint
 * names as allowed into an allow-list (see `allowListOf`).
 */
const OTHERS = /(别的|其他|其它|其余|另外的)|(?:以外|之外)的?(?:工具|东西)|\bother\s+tools?\b|\bany\s+other\b|\bother\s+than\b|\banything\s+(?:else|but)\b/i;
/** "X 是唯一可用的工具", "X is the only tool": an allow-list even without a prohibition word. */
const ONLY_TOOL = /唯一(?:可用|允许|能用|可以用|被允许|可调用)?的?工具|\bthe\s+only\s+(?:allowed\s+)?tools?\b|\bonly\s+(?:allowed\s+)?tools?\b/i;
/** "只用 kb_query", "only use shell": a whitelist that is the WHOLE statement, names and nothing else. */
const NAME_LIST = String.raw`[\x60"']?[A-Za-z0-9_*.-]+[\x60"']?(?:\s*(?:、|,|和|与|及|或|and|or|/)\s*[\x60"']?[A-Za-z0-9_*.-]+[\x60"']?)*`;
const BARE_WHITELIST = new RegExp(
  String.raw`^(?:只(?:用|能用|使用|许用|准用|调用)|仅(?:用|使用|调用)|use\s+only|only\s+use)\s*${NAME_LIST}\s*(?:这?(?:个|些|几个|两个)?工具|tools?)?\s*$`, 'i');

/**
 * Tools that are not "using a tool" for an allow-list's purpose: the agent's own bookkeeping (plan,
 * memo, self-review, pre-flight, error book) and talking to the user (ask_user, report_write).
 * "只用 shell" is about how the WORK is done; recording the plan or delivering the report is not a
 * second way of doing it, and flagging those would make every allow-list fire on every turn.
 * Read-only tools are deliberately NOT exempt: "只用 kb_query" then `fs_read` is exactly what the
 * rule excludes.
 */
const ALLOWLIST_EXEMPT = /^(?:plan_|reflection_|preflight_|errorbook_|memo_|ask_user$|report_write$)/;

/**
 * The tools a constraint ALLOWS when it is an allow-list, or null when it is not one.
 *
 * Measured by the reviewer after R7: 「只用 shell，不要用别的工具」 had the forbidden object
 * 「用别的工具」 — a literal string no call ever contains — so `fs_write` under it was never flagged,
 * and 「只用 kb_query」 had no prohibition word at all. An allow-list is one of:
 *   - a prohibition of OTHER tools (`OTHERS`): 只用 X，不要用别的工具 · 除 X 外不要用其他工具 ·
 *     never use any tool other than X — the allowed tools are the ones in the permitted parts;
 *   - X 是唯一可用的工具 / X is the only tool (`ONLY_TOOL`);
 *   - a bare whitelist that is the whole rule: 只用 kb_query · only use shell.
 * A whitelist that comes with a prohibition of its own object ("不得直读 .she/kb.sqlite，只用 kb_*
 * 工具") is the remedy for THAT prohibition, scoped to it, and stays what it was before: not
 * enforced globally — otherwise every `fs_read` of a source file would be a violation of a rule
 * about the knowledge base. A scoped whitelist ("只用 shell 跑测试", "only use git via shell") is not
 * bare either. Only names that are tool names count; "只用 utf-8" is no allow-list.
 */
export function allowListOf(text: string, isTool: (name: string) => boolean = (n) => isKnownToolName(n)): string[] | null {
  const t = String(text ?? '').replace(PROVENANCE, ' ');
  const analysis = analyzeConstraint(t);
  let source: string[];
  if ((PROHIBITION.test(t) && OTHERS.test(t)) || ONLY_TOOL.test(t)) {
    source = [...analysis.permitted, ...requiredSpans(t)];
  } else {
    const bare = analysis.permitted.filter((p) => BARE_WHITELIST.test(p));
    if (!bare.length || (PROHIBITION.test(t) && prohibitionObject(t, isTool).length)) return null;
    source = bare;
  }
  const names = [...new Set([...source.join(' ').matchAll(/[A-Za-z][A-Za-z0-9_]*\*?/g)].map((m) => m[0].toLowerCase()))]
    .filter((n) => isTool(n));
  return names.length ? names : null;
}

/**
 * Provenance notes inside a constraint: "来源：a1b2c3d4", "(source: c3d4e5f6)", "参见：…".
 *
 * They say where the rule came from, not what it forbids. Left in, the id was picked up as the
 * prohibition's OBJECT (it is the most concrete-looking token in the sentence), and the agent's
 * own `kb_link` to that very node was reported as a violation, measured twice on live runs.
 */
const PROVENANCE = /[（(]?\s*(?:来源|出处|参见|参考|引自|依据|source|ref|see)\s*[:：][^，,；;。!！?？\n)）]*[)）]?/gi;

/**
 * A constraint read into the statements that can create a violation, and the parts that cannot.
 *
 * Split on sentence and clause punctuation, then drop the clauses that grant an exception. A comma
 * alone does not end a clause — "不得改动 a.ts, b.ts" is one prohibition listing two objects — but a
 * comma followed by an exception marker does, which is how "…，唯一允许的是 X" is kept out of the
 * forbidden set without splitting lists apart.
 *
 * No statement means NO object and therefore NO signal, the same rule as a constraint with no
 * extractable object: a check that fires on "the constraint might have been broken" is one the
 * agent learns to skip.
 */
interface ConstraintAnalysis {
  /** Statements that state a prohibition, each as its pieces in order. */
  statements: string[][];
  /** Pieces read as permitted: exceptions, whitelists, prescriptions. */
  permitted: string[];
}

function analyzeConstraint(text: string): ConstraintAnalysis {
  text = String(text ?? '').replace(PROVENANCE, ' ');
  const statements: string[][] = [];
  const permitted: string[] = [];
  let buffer: string[] = [];
  let afterException = false;
  const flush = () => {
    if (buffer.length) statements.push(buffer);
    buffer = [];
  };
  for (const raw of constraintPieces(text)) {
    const piece = raw.trim();
    if (!piece) continue;
    // A clause that prescribes a tool (see `PERMISSION`) is the permitted half, like an exception.
    const exception = EXCEPTION.test(piece) || isPermission(piece);
    /*
     * An exception ends the statement it belongs to. What follows it is a new statement, read on
     * its own — "…，唯一允许的是 X，但不要动 Y" still has to catch the `Y`.
     */
    if (exception || afterException) flush();
    afterException = exception && !PROHIBITION.test(piece);
    // An exception that states no prohibition of its own is the permitted half: kept out entirely.
    if (afterException) {
      permitted.push(piece);
      continue;
    }
    buffer.push(piece);
  }
  flush();
  return { statements: statements.filter((st) => st.some((p) => PROHIBITION.test(p))), permitted };
}

/**
 * One prohibition inside a statement: what stands in front of the prohibition word (`head`: the
 * subject, a description, or a topicalised object) and what follows it (`tail`, including any
 * continuation pieces, "不要动 a.ts，b.ts").
 */
interface ProhibitionSegment { head: string; tail: string }

function segmentsOf(statement: string[]): ProhibitionSegment[] {
  const out: ProhibitionSegment[] = [];
  let pending: string[] = [];
  let cur: ProhibitionSegment | null = null;
  for (const piece of statement) {
    const at = piece.search(PROHIBITION);
    if (at < 0) {
      if (cur) cur.tail += `，${piece}`;
      else pending.push(piece);
      continue;
    }
    if (cur) out.push(cur);
    cur = { head: [...pending, piece.slice(0, at)].join('，'), tail: piece.slice(at) };
    pending = [];
  }
  if (cur) out.push(cur);
  return out;
}

const PROHIBITION_ALL = new RegExp(PROHIBITION.source, 'gi');
/** A CJK run that only points back at something ("改它", "这个") names nothing by itself. */
const PRONOUN = /(它|此|该|其|这|那|上述|以上|前述)/;
/** "其他工具" / "别的" name every tool but the allowed ones; that is `allowListOf`'s job, not an object. */
const OTHERS_RUN = /(别的|其他|其它|其余|另外的)|^工具$/;

interface Candidates { quoted: string[]; commands: string[]; ascii: string[]; cjk: string[] }

function candidatesIn(text: string, isTool: (name: string) => boolean = (n) => isKnownToolName(n)): Candidates {
  let t = String(text ?? '');
  // What the prohibition REQUIRES or exempts ("不要跳过 X", "without calling X", "除 X 外") is not its object.
  for (const re of REQUIRED_SPANS) t = t.replace(re, ' ');
  t = stripToolPossessive(t, isTool);
  const quoted = [...t.matchAll(/[`"“']([^`"”']{2,})[`"”']/g)].map((m) => m[1].trim()).filter(Boolean);
  const unquoted = t.replace(/[`"“']([^`"”']{2,})[`"”']/g, ' ').replace(PROHIBITION_ALL, ' ');
  // A command phrase is one object ("rm -rf", "git push --force"), and its words are not candidates.
  const { commands } = commandsIn(unquoted, isTool);
  let rest = t.replace(PROHIBITION_ALL, ' ');
  for (const c of commands) rest = rest.replace(c, ' ');
  const ascii: string[] = [];
  for (const m of rest.matchAll(/[A-Za-z0-9_@./\\:-]{3,}/g)) {
    const bare = m[0].replace(/^[./\\:-]+|[./\\:-]+$/g, '');
    // A dot-name keeps its dot: the object of "不要改 .git" is the directory, and as bare `git` it matched
    // every `shell` call running a git command. Length is still judged without the dot.
    const w = bare.length >= 3 && /^\.[A-Za-z_]/.test(m[0]) ? `.${bare}` : bare;
    if (bare.length >= 3 && !GENERIC.has(bare.toLowerCase()) && !OBJECT_STOP.has(bare.toLowerCase())) ascii.push(w);
  }
  const cjk: string[] = [];
  for (const m of rest.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = m[0];
    if (GENERIC.has(run) || OTHERS_RUN.test(run)) continue;
    // A CJK candidate is a whole run, not a bigram: the object of "别改 cluster.ts 的导出" is the
    // phrase as written, and splitting it would match any message that happens to share a pair.
    cjk.push(run);
  }
  return { quoted, commands, ascii, cjk };
}

function namesSomething(c: Candidates): boolean {
  return c.quoted.length > 0 || c.commands.length > 0 || c.ascii.length > 0 || c.cjk.some((r) => !PRONOUN.test(r));
}

/**
 * Objects, plus the heads that were read as context. A prohibition's object is what FOLLOWS the
 * prohibition word when anything concrete does: 「shell 由 cmd.exe 解析，不能用 POSIX 写法」 forbids
 * POSIX syntax, and the shell it describes is not the object — measured live, every `shell` call under
 * that constraint was filed in the error book as a violation, and 「本工作区…无 package.json…不得报
 * clean」 turned a `fs_read` of package.json into one. Only when nothing concrete follows ("a.ts 不要
 * 改", "x.ts 是生成的，不要改它") is the head the object, as it always was.
 */
function objectAnalysis(
  text: string,
  isTool: (name: string) => boolean = (n) => isKnownToolName(n) || toolNamedObjects(text).has(n.toLowerCase()),
): { objects: string[]; context: string[] } {
  let quoted: string[] = [];
  let commands: string[] = [];
  let ascii: string[] = [];
  let cjk: string[] = [];
  const context: string[] = [];
  const segments = analyzeConstraint(text).statements.flatMap(segmentsOf);
  for (const seg of segments) {
    const tail = candidatesIn(seg.tail, isTool);
    const parts = [tail];
    if (namesSomething(tail)) {
      if (seg.head.trim()) context.push(seg.head.trim());
    } else {
      parts.unshift(candidatesIn(seg.head, isTool));
    }
    for (const p of parts) { quoted.push(...p.quoted); commands.push(...p.commands); ascii.push(...p.ascii); cjk.push(...p.cjk); }
  }
  /*
   * One prohibition naming a tool AND what it must not be used on (see `SCOPE`): the tool is context,
   * the object is what is matched. Only with a concrete (non-CJK) object to match instead; with a CJK
   * phrase only ("不要用 fs_write 改配置文件") the tool stays the object, as before.
   */
  if (segments.length === 1 && SCOPE.some((re) => re.test(`${segments[0].head}${segments[0].tail}`))) {
    const named = (o: string) => isTool(o.replace(/^[`"']|[`"']$/g, ''));
    const tools = [...quoted, ...ascii].filter(named);
    const concrete = [...quoted.filter((o) => !named(o)), ...commands, ...ascii.filter((o) => !named(o))];
    if (tools.length && concrete.length) {
      context.push(...tools);
      quoted = quoted.filter((o) => !named(o));
      ascii = ascii.filter((o) => !named(o));
      cjk = [];
    }
  }
  // A backticked or quoted span, or a command phrase, wins when present (see `prohibitionObject`).
  if (quoted.length || commands.length) return { objects: [...new Set([...quoted, ...commands])].slice(0, 2), context };
  const unique = [...new Set([...ascii, ...cjk])].sort((a, b) => b.length - a.length);
  return { objects: unique.slice(0, 2), context };
}

/**
 * The object a prohibition is about: what must not be touched.
 *
 * Returns null when nothing specific can be extracted, and that is the common case for a soft
 * preference ("keep it terse"). A null object produces NO signal rather than a vague one — a check
 * that fires on "the constraint might have been broken" is one the agent learns to skip.
 *
 * A backticked or quoted span wins when present, because that is how a person marks the exact token
 * they mean; otherwise the longest concrete-looking candidates are used, capped at two so a sentence
 * full of nouns does not turn into a keyword net.
 *
 * Read from the prohibition statements only (`analyzeConstraint`), not from the whole text: the
 * clauses that grant an exception are not what the constraint forbids (see `EXCEPTION`), and the
 * subject in front of a prohibition with its own object is context (see `objectAnalysis`).
 */
export function prohibitionObject(text: string, isTool?: (name: string) => boolean): string[] {
  return objectAnalysis(text, isTool).objects;
}

function normalizeActions(actions: (DriftAction | string)[]): DriftAction[] {
  return actions.map((a) => (typeof a === 'string' ? { tool: '', summary: a } : a));
}

/**
 * Argument keys that hold text the agent is WRITING ABOUT rather than a target it is acting on.
 *
 * The constraint check below asks "did an action touch the object this prohibition excludes", and
 * it used to read the whole argument blob as one string. That made every call whose PAYLOAD happens
 * to mention the excluded object a violation, and the payload almost always does, because the
 * agent's job is to write down what it knows. Measured on a live run: the constraint
 * `shell 为 Windows cmd：无 cat/which；避免外泄重定向` was reported as violated four times over
 * — by `preflight_record` (which had just DECLARED the constraint), by the `task_spawn` brief that
 * quoted it to a child, by a `plan_update` note reading "cat/which 告警判定为 KB 检索文本误报",
 * and by `fs_write` of a QA note whose *path* was innocent. The agent spent reasoning on a false
 * accusation, which is the one kind of noise that makes people switch a check off.
 *
 * So a violation is now read from the TARGET of the call — `path`, `command`, `scope` — and never
 * from prose: a `content` that quotes the rule, a `note` that discusses it, a `goal` that states
 * it. Dropping the payload can only lose violations where a call names the excluded object solely
 * inside a body of text, and there is nothing to do about those anyway: writing a sentence that
 * mentions `cluster.ts` neither reads nor edits it.
 */
const PROSE_ARGS = new Set([
  'content', 'text', 'body', 'title', 'note', 'notes', 'message', 'summary', 'description',
  'deliverable', 'detail', 'details', 'lesson', 'evidence', 'report', 'markdown', 'md', 'doc',
  'document', 'prompt', 'question', 'answer', 'reason', 'rationale', 'assumptions', 'risks',
  'findings', 'context', 'instructions', 'steps', 'constraints', 'inferred_constraints',
  'stated_intent', 'actual_goal', 'goal',
]);

/** The same arguments with every prose field removed, recursively. Depth-capped against cycles. */
function targetArgs(raw: unknown, depth = 0): unknown {
  if (depth > 3 || raw === null || typeof raw !== 'object') return raw;
  if (Array.isArray(raw)) return raw.map((v) => targetArgs(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (PROSE_ARGS.has(k.toLowerCase())) continue;
    out[k] = targetArgs(v, depth + 1);
  }
  return out;
}

/** What the agent DID: the call it made. */
function actionText(a: DriftAction): string {
  return [a.tool, targetOf(a.args)].filter(Boolean).join(' ');
}

/** The action's arguments, prose stripped. Not JSON means the whole string IS the target. */
function targetOf(args: string | undefined): string {
  if (!args) return '';
  try {
    return JSON.stringify(targetArgs(JSON.parse(args)));
  } catch {
    return args;
  }
}

/**
 * Everything the action brought up, result included.
 *
 * Used where a false positive is cheaper than a false negative: judging whether recent work is
 * still about the goal may legitimately count the material the agent pulled in, and a memory the
 * agent retrieved on purpose is evidence it was looking in the right place.
 *
 * Deliberately the RAW arguments, not `targetArgs`: "was this on topic" is a question about the
 * material the agent had in view, so a plan note or a written report is entirely fair evidence.
 * Only the accusation below — "you touched this" — has to be read from the target alone.
 */
function actionContext(a: DriftAction): string {
  return [a.tool, a.args, a.summary].filter(Boolean).join(' ');
}

/**
 * Compare where the work is against the goal it started from.
 *
 * Pure and deterministic: everything it reports is a quote or a count, so the same inputs give the
 * same report and a test can pin the exact wording of a signal.
 */
/** Tools that record or review the task rather than doing it. */
const BOOKKEEPING = /^(plan_|reflection_|preflight_|errorbook_|memo_)/;

export function detectDrift(input: DriftInput): DriftReport {
  const signals: DriftSignal[] = [];
  const goal = String(input.goal ?? '').trim();
  const terms = goalTerms(goal);
  const actions = normalizeActions(input.actions ?? []);
  const texts = actions.map(actionText);
  const contexts = actions.map(actionContext);

  // ── constraints ──
  const registered = new Set([
    ...(input.toolNames ?? BUILTIN_TOOL_NAMES).map((n) => n.toLowerCase()),
    ...actions.map((a) => (a.tool || '').toLowerCase()).filter(Boolean),
  ]);
  for (const c of input.constraints ?? []) {
    const spec = typeof c === 'string' ? { text: c, hardness: 'hard' as const } : c;
    const hardness = spec.hardness === 'soft' ? 'soft' : 'hard';
    const asTool = toolNamedObjects(spec.text);
    const isTool = (name: string) => asTool.has(name.toLowerCase()) || isKnownToolName(name, registered);
    const objects = PROHIBITION.test(spec.text) ? prohibitionObject(spec.text, isTool) : [];
    const allowed = allowListOf(spec.text, isTool);
    if (!objects.length && !allowed) continue;
    /*
     * Matched against what the agent did, and the matching action is named in the report.
     *
     * Naming it is not decoration: an accusation that does not say which call it came from cannot
     * be checked by the reader, and one that cannot be checked gets ignored wholesale — including
     * the true positives.
     *
     * An object that is a TOOL NAME is compared with the called tool only: under 「用 shell 跑测试，
     * 不要用 fs_write」 a `shell` call reading docs/fs_write.md uses shell, not fs_write. Every other
     * object (a path, `git push --force`, `.git`, kb.sqlite) is still read from the call's target
     * arguments, as before; a command phrase (`rm -rf`, `git push --force`) as a command, its words in
   * order within one command (`commandMatches`). Under an allow-list, a call to any other tool is the violation, and the
     * object reported is that tool.
     */
    let hit: string | null = null;
    let via = '';
    for (let i = 0; i < texts.length && !hit; i++) {
      const tool = actions[i].tool || '';
      let m = objects.find((o) => (isTool(o) ? toolNameMatches(tool, o) : objectInTarget(texts[i], o, isTool))) ?? null;
      if (!m && allowed && tool && !ALLOWLIST_EXEMPT.test(tool.toLowerCase())
        && !allowed.some((n) => toolNameMatches(tool, n))) m = tool;
      if (m) { hit = m; via = tool || '动作'; }
    }
    if (!hit) continue;
    signals.push({
      kind: 'constraint_violated',
      major: hardness === 'hard',
      weight: hardness === 'hard' ? 0.8 : 0.4,
      detail: `约束「${spec.text.trim()}」排除的对象「${hit}」出现在了 ${via} 的调用参数里`,
    });
  }

  // ── goal relevance of the recent actions ──
  /*
   * Three actions is the point where "this one call looked odd" stops being the explanation: a
   * single off-topic call is normal (a `git status` to check state), three in a row with no word
   * from the goal is a direction. Five escalates to major, because by then a real on-task stretch
   * would almost certainly have named the thing it is working on.
   */
  /*
   * What counts as "on topic" is the goal's words OR the current plan step's words.
   *
   * Measured on a live run: the goal "confirm the server restarted (pid 15884 replaced by 17856)"
   * gave the terms `pid`, `15884`, `17856`, and five `netstat`/`lsp`/`kb` probes the plan step had
   * asked for were reported as major drift because none of them spelled a pid. The plan step is
   * the agent's own decomposition of the goal; work that matches it is on task by construction,
   * and a step that is itself off goal is reported separately (`step_off_goal`) below.
   *
   * Bookkeeping calls (plan, reflection, preflight, error book, memo) are left out of the window:
   * they are about the task by definition and say nothing about where the work is heading, so a
   * run of them cannot be "unrelated" and must not push real actions out of the window either.
   */
  const stepTerms = goalTerms(String(input.currentStep ?? ''));
  const anchors = [...terms, ...stepTerms.filter((t) => !terms.includes(t))];
  const work = contexts.filter((_, i) => {
    const tool = (actions[i].tool || '').toLowerCase();
    // A label with no tool is a description the model wrote, not a record of a call. Measured
    // live: labels like "review" / "wrap up" were scored as five unrelated actions and reported
    // as drift 1.00 while every real call was on the goal. Nothing to judge, so not in the window.
    if (!tool) return false;
    // Bookkeeping is out of the window, unless the goal itself is about that tool (a run whose
    // job is to test reflection_check is doing its work when it calls reflection_check).
    if (BOOKKEEPING.test(tool) && !terms.includes(tool)) return false;
    return true;
  });
  if (terms.length && work.length >= 3) {
    const recent = work.slice(-3);
    const matched = recent.map((t) => containsAny(t, anchors));
    if (matched.every((m) => m === null)) {
      const long = work.length >= 5 && work.slice(-5).every((t) => containsAny(t, anchors) === null);
      signals.push({
        kind: 'goal_unrelated',
        major: long,
        weight: long ? 0.7 : 0.5,
        detail: `最近 ${long ? 5 : 3} 个动作没有提到目标里的任何词（目标词如：${terms.slice(0, 5).join('、')}）`,
      });
    }
  }

  // ── the current step ──
  const step = String(input.currentStep ?? '').trim();
  /*
   * A step worded differently from the goal is weak evidence on its own: the model paraphrases
   * ("check the self-check's verdicts" for a goal naming reflection_check), and no word overlap
   * across a paraphrase proves nothing. So it is suppressed when the recent real calls ARE on the
   * goal. Alone it is still only a reminder (watch), never drift.
   */
  const recentOnGoal = work.slice(-3).some((t) => containsAny(t, terms) !== null);
  if (terms.length && step.length >= 4 && !containsAny(step, terms) && !recentOnGoal) {
    signals.push({
      kind: 'step_off_goal',
      major: false,
      weight: 0.4,
      detail: `当前步骤「${step.slice(0, 80)}」没有提到目标里的任何词`,
    });
  }

  // ── budget ──
  if (input.stepBudget !== undefined && input.stepsUsed !== undefined && input.stepsUsed > input.stepBudget) {
    signals.push({
      kind: 'budget_overrun',
      major: false,
      weight: 0.5,
      detail: `已用 ${input.stepsUsed} 次工具调用，超过预算的 ${input.stepBudget} 次`,
    });
  }

  const score = Math.min(1, signals.reduce((s, x) => s + x.weight, 0));
  const major = signals.some((s) => s.major);
  const level: DriftLevel = major ? 'drift' : score >= 0.4 ? 'watch' : 'none';

  return { level, score, signals, advice: driftAdvice(level, signals), replan: major };
}

function driftAdvice(level: DriftLevel, signals: DriftSignal[]): string | null {
  if (level === 'none') return null;
  const parts: string[] = [];
  if (signals.some((s) => s.kind === 'constraint_violated')) {
    parts.push('你在触碰明确排除的对象：停下来，换成不越界的做法；如果确实必须越界，先问用户，不要自己决定。');
  }
  if (signals.some((s) => s.kind === 'goal_unrelated' || s.kind === 'step_off_goal')) {
    parts.push('把 preflight 记录的「实际目标」重读一遍，再确认当前步骤在为它服务；不是就重写计划。');
  }
  if (signals.some((s) => s.kind === 'budget_overrun')) {
    parts.push('这一轮已经超预算：收尾并交付「已完成 + 未完成」，把剩下的交给下一轮，不要硬撑。');
  }
  parts.push('如果你核对后确认这些动作确实服务于目标，说明理由即可继续——本条是提醒，不是否决。');
  return parts.join(' ');
}

const LEVEL_LABEL: Record<DriftLevel, string> = {
  none: '无漂移',
  watch: '需要留意',
  drift: '已漂移',
};

/** One block for a prompt or a receipt. Empty string when there is nothing to say. */
export function renderDrift(r: DriftReport): string {
  if (r.level === 'none') return '';
  const lines = [`漂移检查：${LEVEL_LABEL[r.level]}（得分 ${r.score.toFixed(2)}）`];
  for (const s of r.signals) lines.push(`- ${s.detail}`);
  if (r.advice) lines.push(`建议：${r.advice}`);
  return lines.join('\n');
}

// ─── Confidence mirror ──────────────────────────────────────────────────────

/**
 * One run's claim and its outcome.
 *
 * `attempted`/`succeeded` are tool CALLS, not steps: the mirror's question is whether a stated
 * confidence predicts the agent's ability to get its tools to do what it said, which is the part of
 * the work that is measurable at all.
 */
export interface ConfidenceSample {
  at: string;
  /** What the agent said it expected, 0..1. */
  claimed: number;
  attempted: number;
  succeeded: number;
  /** The pre-flight clamp had to lower the claim; independent evidence of overreach. */
  clamped: boolean;
  topic?: string;
  runId?: string;
}

export type CalibrationBucket = 'unknown' | 'calibrated' | 'overconfident' | 'underconfident';

export interface CalibrationReport {
  samples: number;
  /** Mean of the claims. */
  meanClaimed: number;
  /** Mean of `succeeded / attempted` — the measured rate. 1 when nothing was attempted. */
  actualRate: number;
  /** `meanClaimed - actualRate`. Positive means overconfident. */
  bias: number;
  bucket: CalibrationBucket;
  /** Share of samples the pre-flight clamp had to bring down, 0..1. */
  clampRate: number;
  /** Topics whose bias is worst, when there are enough samples to say. */
  worst: { topic: string; samples: number; bias: number }[];
  advice: string | null;
}

/**
 * Fewer than this and the mirror says nothing.
 *
 * Two samples is a coincidence, and a calibration warning issued on a coincidence teaches the agent
 * to discount the warning. The number is per-window, not per-topic, for the overall verdict, because
 * the mirror's useful claim is about the agent's habits rather than about one task.
 */
const MIN_SAMPLES = 3;

/**
 * How far apart the claim and the measurement have to be before it is a bias.
 *
 * 0.15 would flag ordinary noise on a three-sample window; 0.25 is roughly the gap where the
 * confidence number stops being usable as a probability at all.
 */
const BIAS_THRESHOLD = 0.25;

/** Beyond this many samples the oldest are dropped: a habit is recent, and the file stays small. */
const DEFAULT_KEEP = 200;

export interface ConfidenceStoreFile {
  schema_version: number;
  samples: ConfidenceSample[];
}

/**
 * One sample as it appears in the workspace-wide ledger: numbers only.
 *
 * The `at` field is a timestamp, not text — it is what makes `window` mean the same thing in both
 * files. Everything that could carry a sentence (`topic`, `runId`) is deliberately absent, and the
 * writer builds this object key by key rather than by deleting keys from a full sample, because
 * "forgot to delete one field" is exactly the mistake that would quietly put another conversation's
 * task text into a file every conversation reads.
 */
export interface IndexedSample {
  at: string;
  claimed: number;
  attempted: number;
  succeeded: number;
  clamped: boolean;
}

export interface ConfidenceIndexFile {
  schema_version: number;
  samples: IndexedSample[];
}

export const CONFIDENCE_SCHEMA = 1;
/** The workspace ledger's schema, versioned separately: it is a different file with a different shape. */
export const CONFIDENCE_INDEX_SCHEMA = 1;
export const REFLECTION_DIR = join('.she', 'reflection');

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * The confidence mirror, on disk — in two files, because its two halves have different owners.
 *
 *   - `.she/sessions/<sessionId>/confidence.json` — this conversation's samples, with the topic text.
 *     Readable only from inside that conversation, like its plans and its notes.
 *   - `.she/reflection/confidence.json` — the same samples reduced to numbers, workspace-wide. This is
 *     what the VERDICT comes from, and it is the reason the mirror still works across restarts.
 *
 * The split exists because the old single file forced a choice between two things that are both
 * required: a shared file is the only way to observe a habit across sessions — a bias that resets on
 * every restart is invisible, and the restart is exactly when the agent would otherwise start with a
 * clean slate and the same optimism — but a shared file is also a file every conversation can read
 * in full, and this one held the task text of every run in the workspace. Numbers can be shared;
 * sentences cannot. So the shared half keeps only what the arithmetic needs.
 *
 * What the split costs, stated rather than hidden: the per-topic breakdown (`worst`) can only be
 * computed over THIS conversation's samples, because a topic label is user text. The overall verdict
 * is a cross-session habit; the list of worst topics is a reading of the current conversation.
 *
 * Written atomically (tmp + rename) for the same reason as `.she/preflight/*`: a truncated JSON file
 * would take the entire history with it on the next read, and this file's whole value is its history.
 */
export class ConfidenceMirror {
  private cache: ConfidenceSample[] | null = null;
  private indexCache: IndexedSample[] | null = null;
  private mineStamp: string | null = null;
  private indexStamp: string | null = null;

  /**
   * A cheap identity for a file, used to notice that someone else rewrote it.
   *
   * There is more than one mirror over the same paths: the server keeps its own per session (so a
   * panel poll does not re-read a file on every tick) while each `Agent` owns another. Both write.
   * Without this, a reset served by one instance left the other one still reporting the numbers it
   * had in memory — the file was cleared and the screen kept showing the old verdict. One stat per
   * read is the difference between a cache and a stale copy.
   */
  private static stamp(file: string): string {
    try {
      const st = statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return 'missing';
    }
  }

  constructor(
    private workspaceRoot: string,
    /**
     * The conversation whose samples are readable here. Null for an agent built without one, which
     * can still read and extend the numeric ledger but has no per-conversation file to read or write.
     */
    private sessionId: string | null = null,
    private keep = DEFAULT_KEEP,
  ) {}

  /** The workspace ledger — the numbers, with no text. What `report()` reads its verdict from. */
  private indexFile(): string {
    return join(this.workspaceRoot, REFLECTION_DIR, 'confidence.json');
  }

  /** This conversation's own samples, with topics. Null when there is no conversation. */
  private mineFile(): string | null {
    return this.sessionId ? join(sessionStateDir(this.workspaceRoot, this.sessionId), 'confidence.json') : null;
  }

  /**
   * This conversation's samples, newest last.
   *
   * Empty rather than an error when there is no session or no file: the API route asks for this to
   * render a list, and "nothing recorded here yet" is a normal state on a fresh conversation.
   */
  samples(): ConfidenceSample[] {
    const file = this.mineFile();
    if (!file) {
      this.cache = [];
      this.mineStamp = 'missing';
      return this.cache;
    }
    const stamp = ConfidenceMirror.stamp(file);
    if (this.cache && this.mineStamp === stamp) return this.cache;
    this.mineStamp = stamp;
    this.cache = readSamplesFile(file).samples;
    return this.cache;
  }

  /** The workspace ledger, newest last. Numbers only — there is no text in this file to return. */
  indexSamples(): IndexedSample[] {
    const file = this.indexFile();
    const stamp = ConfidenceMirror.stamp(file);
    if (this.indexCache && this.indexStamp === stamp) return this.indexCache;
    this.indexStamp = stamp;
    this.indexCache = readSamplesFile(file).samples.map(toIndexedSample);
    return this.indexCache;
  }

  /** Append one observation, and persist both halves. */
  observe(sample: {
    claimed: number;
    attempted: number;
    succeeded: number;
    clamped?: boolean;
    topic?: string;
    runId?: string;
    at?: string;
  }): ConfidenceSample {
    const attempted = Math.max(0, Math.floor(sample.attempted));
    const full: ConfidenceSample = {
      at: sample.at ?? new Date().toISOString(),
      claimed: clamp01(sample.claimed),
      attempted,
      // Clamped to what was attempted: a caller that miscounts successes must not be able to make
      // the measured rate exceed 1, which would read as under-confidence and invert the verdict.
      succeeded: Math.min(Math.max(0, Math.floor(sample.succeeded)), attempted),
      clamped: sample.clamped === true,
      topic: sample.topic,
      runId: sample.runId,
    };

    /*
     * The ledger first, and through `toIndexedSample` — the one place that decides which fields
     * cross a session boundary. The full sample (with its topic) is written only under the session's
     * own directory, and only when there is a session to write it under.
     */
    const indexed = [...this.indexSamples(), toIndexedSample(full)].slice(-this.keep);
    this.save(this.indexFile(), { schema_version: CONFIDENCE_INDEX_SCHEMA, samples: indexed });
    this.indexCache = indexed;
    this.indexStamp = ConfidenceMirror.stamp(this.indexFile());

    const mine = this.mineFile();
    if (mine) {
      const list = [...this.samples(), full].slice(-this.keep);
      this.save(mine, { schema_version: CONFIDENCE_SCHEMA, samples: list });
      this.cache = list;
      this.mineStamp = ConfidenceMirror.stamp(mine);
    }
    return full;
  }

  private save(target: string, payload: ConfidenceStoreFile | ConfidenceIndexFile): void {
    try {
      mkdirSync(dirname(target), { recursive: true });
      const tmp = join(dirname(target), `.confidence-${randomUUID().slice(0, 8)}.tmp`);
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, target);
    } catch {
      // The mirror is bookkeeping. A read-only workspace costs the observation, not the turn.
    }
  }

  /**
   * Forget everything: the ledger, and this conversation's samples with it.
   *
   * The ledger is the half the verdict comes from, so clearing only the session file would leave the
   * agent still being told about the habit it just asked to forget. The other conversations' sample
   * files are left alone: they hold their own text and are theirs to clear.
   */
  clear(): void {
    this.save(this.indexFile(), { schema_version: CONFIDENCE_INDEX_SCHEMA, samples: [] });
    this.indexCache = [];
    this.indexStamp = ConfidenceMirror.stamp(this.indexFile());
    const mine = this.mineFile();
    this.cache = [];
    this.mineStamp = 'missing';
    if (mine) {
      this.save(mine, { schema_version: CONFIDENCE_SCHEMA, samples: [] });
      this.mineStamp = ConfidenceMirror.stamp(mine);
    }
  }

  /**
   * The bias, over the most recent `window` samples of the workspace ledger.
   *
   * A window rather than everything ever recorded: a habit that was corrected should stop being
   * reported, and an all-time average would keep the old bias alive forever.
   */
  report(opts: { window?: number } = {}): CalibrationReport {
    const all = this.indexSamples();
    const list = opts.window ? all.slice(-opts.window) : all;
    if (list.length < MIN_SAMPLES) {
      return {
        samples: list.length,
        meanClaimed: 0,
        actualRate: 0,
        bias: 0,
        bucket: 'unknown',
        clampRate: list.length ? list.filter((s) => s.clamped).length / list.length : 0,
        worst: topicsOf(this.samples(), opts.window),
        advice: null,
      };
    }

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanClaimed = mean(list.map((s) => s.claimed));
    // A run with no tool calls still tells us something about the CLAIM only, so it is excluded
    // from the measured rate rather than counted as a perfect 1.0 — that would let "I did nothing"
    // read as "I was right", which is the failure this mirror exists to catch.
    const withTools = list.filter((s) => s.attempted > 0);
    const actualRate = withTools.length
      ? mean(withTools.map((s) => Math.min(1, s.succeeded / s.attempted)))
      : meanClaimed;
    const bias = meanClaimed - actualRate;
    const bucket: CalibrationBucket =
      bias >= BIAS_THRESHOLD ? 'overconfident' : bias <= -BIAS_THRESHOLD ? 'underconfident' : 'calibrated';
    const clampRate = list.filter((s) => s.clamped).length / list.length;

    return {
      samples: list.length,
      meanClaimed,
      actualRate,
      bias,
      bucket,
      clampRate,
      // From this conversation's samples, not from the ledger — a topic IS the task text, so it is
      // the one thing that must not cross a session boundary. See the class comment.
      worst: topicsOf(this.samples(), opts.window),
      advice: calibrationAdvice(bucket, bias, list.length, clampRate),
    };
  }
}

/**
 * The topics this conversation is worst calibrated on, worst first.
 *
 * Kept separate from the verdict because they come from different files: the verdict is the
 * workspace ledger (numbers), this is the session's own samples (text). Taking `window` from the
 * same option keeps the two halves describing the same stretch of time.
 */
function topicsOf(all: ConfidenceSample[], window?: number): CalibrationReport['worst'] {
  const list = window ? all.slice(-window) : all;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const rate = (xs: ConfidenceSample[]) => {
    const withTools = xs.filter((s) => s.attempted > 0);
    // No measurable run in this topic: the claim is all we have, so the bias is 0 rather than
    // unknown — the topic simply cannot be reported as the worst offender.
    if (!withTools.length) return mean(xs.map((s) => s.claimed));
    return mean(withTools.map((s) => Math.min(1, s.succeeded / s.attempted)));
  };
  const byTopic = new Map<string, ConfidenceSample[]>();
  for (const s of list) {
    if (!s.topic) continue;
    byTopic.set(s.topic, [...(byTopic.get(s.topic) ?? []), s]);
  }
  return [...byTopic.entries()]
    .filter(([, xs]) => xs.length >= MIN_SAMPLES)
    .map(([topic, xs]) => ({
      topic,
      samples: xs.length,
      bias: mean(xs.map((s) => s.claimed)) - rate(xs),
    }))
    // Worst first by absolute distance, so an over-confident topic and an under-confident one are
    // both surfaced — the mirror is about calibration, not about pessimism.
    .sort((a, b) => Math.abs(b.bias) - Math.abs(a.bias))
    .slice(0, 3);
}

/**
 * The only field-level translation into the shared ledger.
 *
 * Written as a constructor of exactly the five numeric fields, never as a copy minus `topic`: a
 * spread with one name deleted is a line that a later field addition silently defeats, and the file
 * it writes is readable from every conversation in the workspace.
 */
function toIndexedSample(s: ConfidenceSample): IndexedSample {
  return {
    at: s.at,
    claimed: clamp01(s.claimed),
    attempted: Math.max(0, Math.floor(s.attempted) || 0),
    succeeded: Math.max(0, Math.floor(s.succeeded) || 0),
    clamped: s.clamped === true,
  };
}

/**
 * Read a samples file, tolerating a missing, damaged or hand-edited one.
 *
 * Re-validated rather than trusted in both directions: these files outlive the version that wrote
 * them, and a half-written entry must not become a NaN in every average afterwards. Entries are
 * rebuilt field by field, so a key this version does not know about is DROPPED rather than carried —
 * which is also what makes the shared ledger safe to read from a workspace where an older build left
 * topic text in it: the text is ignored here and gone from the file the first time anything is
 * appended.
 */
function readSamplesFile(file: string): { samples: ConfidenceSample[] } {
  try {
    if (!existsSync(file)) return { samples: [] };
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ConfidenceStoreFile>;
    const list = Array.isArray(parsed?.samples) ? parsed.samples : [];
    return {
      samples: list
        .filter((s) => typeof s?.claimed === 'number')
        .map((s) => ({
          at: String(s.at ?? ''),
          claimed: clamp01(Number(s.claimed)),
          attempted: Math.max(0, Number(s.attempted) || 0),
          succeeded: Math.max(0, Number(s.succeeded) || 0),
          clamped: s.clamped === true,
          topic: s.topic ? String(s.topic) : undefined,
          runId: s.runId ? String(s.runId) : undefined,
        })),
    };
  } catch {
    return { samples: [] };
  }
}

function calibrationAdvice(bucket: CalibrationBucket, bias: number, samples: number, clampRate: number): string | null {
  if (bucket === 'calibrated') return null;
  const gap = Math.abs(bias).toFixed(2);
  if (bucket === 'overconfident') {
    let text = `最近 ${samples} 次里，你报的置信度平均比实际成功率高出 ${gap}。把置信度改成从已核对的事实推出来的数字，而不是从感觉。`;
    if (clampRate >= 0.5) text += `其中 ${Math.round(clampRate * 100)}% 的预检要被压到上限才合规——这一点也要算进你的自评。`;
    return text;
  }
  return `最近 ${samples} 次里，你报的置信度平均比实际成功率低 ${gap}。你的检查比你以为的更有效，不要因为不确定就少做验证或把已完成的说成没做完。`;
}

/** One line for a status bar, or a prompt block. Empty when there is not enough evidence. */
export function renderCalibration(r: CalibrationReport): string {
  if (r.bucket === 'unknown' || !r.advice) return '';
  const head = r.bucket === 'overconfident' ? '偏乐观' : '偏保守';
  return [
    `置信度镜像：${head}（样本 ${r.samples}，自评均值 ${r.meanClaimed.toFixed(2)}，实际成功率 ${r.actualRate.toFixed(2)}）`,
    r.advice,
    // 样本数与均值来自跨会话的数字账，领域名只能来自本会话 —— 标出来，否则读的人会以为"偏差最大的领域"
    // 也是全局的，而它只可能是一个会话里的任务文本。
    ...(r.worst.length ? [`偏差最大的领域（本会话）：${r.worst.map((w) => `${w.topic}(${w.bias >= 0 ? '+' : ''}${w.bias.toFixed(2)})`).join('、')}`] : []),
  ].join('\n');
}

// ─── Reflections ────────────────────────────────────────────────────────────

export interface ReflectionFailure {
  tool: string;
  kind: string;
  detail: string;
  remedy?: string | null;
}

export interface ReflectionSources {
  goal: string;
  drift: DriftReport;
  calibration: CalibrationReport;
  /** Failures this run wrote to the error book. */
  failures?: ReflectionFailure[];
  /** True when the turn did not produce an answer. */
  runFailed: boolean;
  /** Why it stopped: `max_iterations`, `aborted`, an error message. */
  runReason?: string;
}

/**
 * One lesson for the error book.
 *
 * `topic` is the group the entry is filed under and the signature it is de-duplicated on, so the
 * same lesson recurring is one entry with a count rather than five entries saying the same thing.
 */
export interface ReflectionNote {
  topic: string;
  /** What to do differently next time. The only part that changes behaviour. */
  lesson: string;
  /** The observation that justifies the lesson. Quoted, never inferred. */
  evidence: string;
  /** Lower sorts later; the cap below keeps the notable ones. */
  severity: number;
}

/**
 * At most this many notes per turn.
 *
 * The book is read before work starts and competes with the task for attention, so a turn that
 * produces six lessons would bury the two that matter. Ordered by severity, then truncated.
 */
const MAX_NOTES = 3;

/** The same tool failing this many times in one turn is a pattern, not bad luck. */
const REPEAT_THRESHOLD = 2;

/**
 * Turn a run's observations into lessons.
 *
 * Every rule below is keyed to something the deterministic layers measured. Nothing here is derived
 * from what the model said about itself — a self-assessment that has already been shown to be
 * miscalibrated is the last thing to build a lesson on.
 */
export function deriveReflections(src: ReflectionSources): ReflectionNote[] {
  const notes: ReflectionNote[] = [];

  const violated = src.drift.signals.filter((s) => s.kind === 'constraint_violated');
  if (violated.length) {
    notes.push({
      topic: '越过约束',
      lesson: '约束里明确排除的对象，开工前先列出禁改清单，动手前把路径比对一遍；确实必须越界就先问，不要自己决定。',
      evidence: violated.map((s) => s.detail).join('；'),
      severity: 10,
    });
  }

  if (src.drift.level === 'drift') {
    notes.push({
      topic: '目标漂移',
      lesson: '每做完几步就把 preflight 记录的「实际目标」重读一遍；计划步骤不再直接服务于它就重写计划，而不是继续往下做。',
      evidence: src.drift.signals.map((s) => s.detail).join('；'),
      severity: 8,
    });
  }

  if (src.calibration.bucket === 'overconfident') {
    notes.push({
      topic: '过度自信',
      lesson: '自评置信度要由已核对的证据推出（跑过什么、看到什么），不要给感觉打分；拿不出证据的步骤按 0.5 以下报。',
      evidence: `样本 ${src.calibration.samples}，自评均值 ${src.calibration.meanClaimed.toFixed(2)}，实际成功率 ${src.calibration.actualRate.toFixed(2)}，偏差 ${src.calibration.bias.toFixed(2)}`,
      severity: 6,
    });
  }

  if (src.runFailed && src.runReason === 'max_iterations') {
    notes.push({
      topic: '循环失控',
      lesson: '同一类动作连续失败两次就要换方法或换工具，不要原地重试；到上限前先把「已完成 + 未完成」交付出来。',
      evidence: '本轮因为工具调用轮数达到上限而被停止',
      severity: 7,
    });
  }

  // Repeated failure of one tool inside this turn. The error book already holds the individual
  // failures; what it cannot see from a single entry is that this turn kept hitting the same one.
  //
  // Only the failures the book itself would keep, by the book's own predicate. A third of the
  // kinds are not mistakes at all — `empty` above all, where a `kb_query` that answered "no
  // results" SUCCEEDED and the prompt explicitly tells the agent to re-ask with different words.
  // Measured on a live run: two such answers in one turn became a durable lesson named
  // `重复失败:kb_query` about a tool that had not failed once, and the agent spent a step arguing
  // with it. Sharing the predicate is what keeps this rule and `recordMistake` from disagreeing
  // about what counts as going wrong.
  const byTool = new Map<string, ReflectionFailure[]>();
  for (const f of src.failures ?? []) {
    if (!isWorthRemembering(f.kind)) continue;
    byTool.set(f.tool, [...(byTool.get(f.tool) ?? []), f]);
  }
  for (const [tool, list] of byTool) {
    if (list.length < REPEAT_THRESHOLD) continue;
    const kinds = [...new Set(list.map((f) => f.kind))].join('/');
    notes.push({
      topic: `重复失败:${tool}`,
      lesson: list.find((f) => f.remedy)?.remedy
        ?? `同一工具本轮失败 ${list.length} 次：先读它上一次的报错全文再重试，第二次失败就换工具或换思路。`,
      evidence: `本轮 ${tool} 失败 ${list.length} 次（${kinds}）：${list.map((f) => f.detail).join(' | ').slice(0, 300)}`,
      severity: 5,
    });
  }

  return notes.sort((a, b) => b.severity - a.severity).slice(0, MAX_NOTES);
}

/** One note as one line, for a receipt or a log. */
export function renderReflection(n: ReflectionNote): string {
  return `[${n.topic}] ${n.lesson}`;
}

// ─── Tools ──────────────────────────────────────────────────────────────────

/** What `reflection_check` needs from the agent to answer honestly. */
export interface ReflectionToolDeps {
  /** The goal, from the newest pre-flight record or the active plan. */
  goal: () => string | null;
  /** Constraints as recorded, with their source's hardness. */
  constraints: () => (string | { text: string; hardness?: 'hard' | 'soft' })[];
  /** Actions this run has taken, oldest first. */
  actions: () => DriftAction[];
  /** The plan step being worked on, if a plan is open. */
  currentStep: () => string | null;
  /** Steps used and the budget, when a plan is open. */
  budget: () => { used: number; limit?: number };
  /** Calibration, for the same report. */
  calibration: () => CalibrationReport;
  /** The agent's registered tool names (see `DriftInput.toolNames`). Optional. */
  toolNames?: () => string[];
}

export interface ReflectionToolSet {
  definitions: import('@she/shared').ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}

/**
 * The agent-facing tool.
 *
 * Read-only by construction: it reports and advises, and cannot edit the plan or the goal itself.
 * That is deliberate — a checker that can rewrite the thing it is checking will eventually be used
 * to make itself pass, and this one's value is entirely in being an independent reading.
 */
export function createReflectionTools(deps: ReflectionToolDeps): ReflectionToolSet {
  const definitions: import('@she/shared').ToolDefinition[] = [
    {
      name: 'reflection_check',
      description:
        '在长任务中途自检：把当前动作与最初的「实际目标/约束」对照，报告语义漂移、预算超支和置信度偏差。只读，不修改计划。'
        + '做完一个阶段、连续几步没进展、或准备说「完成」之前调用一次。',
      parameters: {
        type: 'object',
        properties: {
          current_step: { type: 'string', description: '当前正在做的计划步骤（一句话）。省略则用计划里的当前步骤。' },
          actions: {
            type: 'array',
            items: { type: 'string' },
            description: '可选，一句话描述要核对的动作，只作参考；漂移判断以本轮实际执行过的工具调用为准。',
          },
        },
        required: [],
      },
    },
  ];

  const execute = async (_name: string, args: Record<string, unknown>): Promise<string> => {
    const goal = deps.goal();
    if (!goal) {
      return '还没有记录过目标：先调用 preflight_record 写下实际目标，再来自检。';
    }
    const passedActions = Array.isArray(args.actions) ? (args.actions as unknown[]).map(String) : null;
    // Judge the calls that actually ran; a list the model writes is a description, not a record.
    const recorded = deps.actions();
    const actions = recorded.length ? recorded : (passedActions ?? []).map((s) => ({ tool: '', summary: s }));
    const step = typeof args.current_step === 'string' && args.current_step.trim()
      ? args.current_step.trim()
      : deps.currentStep();
    const budget = deps.budget();
    const drift = detectDrift({
      goal,
      constraints: deps.constraints(),
      actions,
      currentStep: step,
      stepsUsed: budget.used,
      stepBudget: budget.limit,
      toolNames: deps.toolNames?.(),
    });

    const parts: string[] = [
      `目标：${goal.slice(0, 200)}`,
      `检查了 ${actions.length} 个动作${step ? `，当前步骤「${step.slice(0, 80)}」` : ''}`,
      renderDrift(drift) || '漂移检查：无漂移（动作与目标的关键词仍然一致）。',
    ];
    if (passedActions?.length && recorded.length) {
      parts.push(`你传入的 ${passedActions.length} 条动作描述只作参考；漂移按本轮实际执行过的工具调用来判断（自己写的描述不是调用记录）。`);
    }
    const cal = deps.calibration();
    const calText = renderCalibration(cal);
    if (calText) parts.push(calText);
    if (drift.level === 'none' && !calText) parts.push('结论：目前没有偏离需要处理，继续。');
    return parts.join('\n');
  };

  return { definitions, execute };
}
