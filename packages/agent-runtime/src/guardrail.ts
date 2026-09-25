/**
 * The outbound guardrail: what the agent is about to hand over, checked before it leaves.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT "REDACT THE ANSWER"
 *
 * The obvious implementation of a compliance guardrail rewrites the output: find a credential,
 * replace it with `***`, move on. It is the wrong default here, for two reasons that are both about
 * being trusted on the day it matters.
 *
 * First, the answer and the transcript would stop corresponding. This project's whole self-review
 * family (the critic, the run trace, the delivery template) works by comparing what the agent SAID
 * against what actually happened; an answer that was silently edited after the fact breaks that
 * comparison in the direction nobody can detect. The user would read a sentence the model never
 * wrote, and no file on disk would say so.
 *
 * Second, it would be wrong about the data. A user who asks "why is my key being rejected" is
 * asking about the key; blanking it out of the reply makes the reply useless, and the key is
 * already in their own terminal. Silently censoring a person's own data is a failure mode that
 * costs trust at the moment they are already frustrated.
 *
 * So the two halves are split by the cost of being wrong:
 *
 *   - **An answer**: DETECTED and reported, never rewritten. The user is told, in the turn, that
 *     this reply contains something they should not forward — and the finding is recorded so the
 *     question "did we ever emit a credential" is answerable afterwards.
 *   - **A delivery artifact** (`report_write`): REFUSED. That file is written into the workspace to
 *     be shared with other people and attached to things; a credential in it is a leak that outlives
 *     the conversation, and the agent can fix it in one turn because it still has the context. The
 *     refusal names what to remove, and an explicit `acknowledge_sensitive: true` overrides it —
 *     a deliberate choice is recorded rather than policed, the same stance the stylesheet guard
 *     takes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE PATTERNS ARE NARROW
 *
 * A guardrail that cries wolf is one the user learns to dismiss, and then it protects nothing. So
 * every rule here is anchored on a shape that is essentially never ordinary prose: a known vendor
 * prefix with enough entropy behind it (`sk-…`, `ghp_…`, `AKIA…`), a PEM block, a three-part JWT, a
 * `user:password@host` authority, or a credential-NAMED key with a value long enough to be one.
 *
 * What is deliberately NOT here: bare high-entropy strings ("that looks like a token"). Git hashes,
 * UUIDs, base64 blobs in a diff and minified bundles all look like that, and a check that fires on
 * `git log` output is worse than no check at all. The same reasoning excludes guessing at personal
 * data from shape — an 18-digit number is as likely to be an order id as an id card.
 *
 * The result is a check with a small, explainable surface: it will not catch a credential whose
 * shape it does not know, and it says so in the docs rather than implying coverage it does not have.
 */


/** What was found. Ordered by how much damage it does if it leaves the machine. */
export type GuardrailKind =
  /** A PEM private key block. Nothing else in a normal answer looks like this. */
  | 'private_key'
  /** A recognised vendor key: OpenAI/DeepSeek `sk-`, GitHub `ghp_`, AWS `AKIA`, … */
  | 'api_key'
  /** A three-part JWT — a bearer credential in URL-safe base64. */
  | 'jwt'
  /** `Authorization: Bearer <opaque>` pasted into prose or a code block. */
  | 'bearer'
  /** `scheme://user:password@host` — a connection string with the password in it. */
  | 'connection_string'
  /** A credential-NAMED key with a value: `TOKEN=…`, `密钥：…`. */
  | 'credential_assignment'
  /** Not a secret: the answer, or a span of it, declares itself confidential. */
  | 'confidential_marker';

export type GuardrailSeverity = 'high' | 'note';

export interface GuardrailFinding {
  kind: GuardrailKind;
  /** `high` blocks a delivery; `note` is reported and never blocks. */
  severity: GuardrailSeverity;
  /** Short human label, in the user's language. */
  label: string;
  /** Offset in the scanned text, so a caller can act on the span. */
  index: number;
  /** Length of the matched span. */
  length: number;
  /**
   * The match with its middle removed.
   *
   * Masked at the point of construction rather than when rendering, so a full credential cannot
   * reach a log line, an API response or an audit record by way of a caller that forgot.
   */
  preview: string;
}

export type GuardrailPolicy = 'off' | 'warn';

/**
 * How the guardrail behaves for a *conversational answer*.
 *
 * `warn` is the only useful value for an answer, because the alternative is silent rewriting (see
 * the header). `off` exists for the case where the work IS about credentials — writing the docs for
 * an API, rotating keys — and a warning on every turn is noise.
 */
export function guardrailPolicy(raw: string | undefined = process.env.SHE_GUARDRAIL): GuardrailPolicy {
  return String(raw ?? '').trim().toLowerCase() === 'off' ? 'off' : 'warn';
}

export function guardrailEnabled(raw?: string): boolean {
  return guardrailPolicy(raw) !== 'off';
}

interface Rule {
  kind: GuardrailKind;
  severity: GuardrailSeverity;
  label: string;
  re: RegExp;
  /**
   * Last say on whether a regex hit is a real finding.
   *
   * Exists for exactly one rule (`connection_string`), and for a reason worth stating: the shape
   * `user:pass@host` is also how every document writes a connection string it does NOT want to leak.
   * `<PASSWORD>`, `${DB_PASSWORD}`, `***` are the *recommended* form of the same string, so a rule
   * that fires on them punishes the fix. The refusal message in `renderGuardrailRefusal` literally
   * tells the model to write `<YOUR_API_KEY>`; a guardrail that then rejects its own advice is how it
   * gets switched off.
   *
   * Deliberately narrow, because the opposite miss is worse: `admin:password@host` — a real default
   * credential — still fires. Only shapes that cannot be a value are skipped.
   */
  accept?: (m: RegExpExecArray) => boolean;
}

/**
 * True when a `user:secret@host` secret segment is a placeholder rather than a value.
 *
 * The four forms below are the ones people actually write, and each one is unmistakable: the whole
 * segment is bracketed, it is a variable reference, it is one character repeated, or it names itself
 * as a placeholder. Anything else — including the word `password` on its own — is treated as a value,
 * because a default credential is a real leak and this rule is one of the few that catches it.
 */
function isPlaceholderSecret(secret: string): boolean {
  const s = secret.trim();
  if (!s) return true;
  // `***`, `xxxxx`, `@@@@` — a mask, not a password.
  if (/^(.)\1{2,}$/.test(s)) return true;
  // `<PASSWORD>`, `[password]`, `{password}`, `{{password}}`, `(password)`, `«password»`.
  if (/^[<[{("«]\s*[^<>[\]{}()"»]{0,64}\s*[>\]})"»]$/.test(s)) return true;
  // `${DB_PASSWORD}`, `$DB_PASSWORD`, `%DB_PASSWORD%`, `ENV:DB_PASSWORD`.
  if (/^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%|env:)/i.test(s)) return true;
  const upper = s.toUpperCase();
  return /PLACEHOLDER|REDACTED|CHANGEME|CHANGE_ME|YOUR_PASSWORD|YOURPASSWORD|YOUR_SECRET|EXAMPLE|占位符|你的密码|自己填|请替换|不需要填/.test(upper);
}

/*
 * Every rule is global: one answer can leak the same kind twice, and the count is part of what the
 * user needs to know ("两处" is a different instruction from "一处").
 */
const RULES: Rule[] = [
  {
    kind: 'private_key',
    severity: 'high',
    label: '私钥块',
    re: /-----BEGIN [A-Z ]{0,24}PRIVATE KEY-----[\s\S]*?-----END [A-Z ]{0,24}PRIVATE KEY-----/g,
  },
  {
    kind: 'jwt',
    severity: 'high',
    label: 'JWT',
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  },
  {
    kind: 'api_key',
    severity: 'high',
    label: '接口密钥',
    // Vendor prefixes with real entropy behind them. An `sk-` followed by fewer than 16 characters
    // is not a key (and `sk-learn` in prose is exactly why the length floor is there).
    re: /\b(?:(?:sk|rk)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{16,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g,
  },
  {
    kind: 'bearer',
    severity: 'high',
    label: 'Bearer 令牌',
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  },
  {
    kind: 'connection_string',
    severity: 'high',
    label: '带密码的连接串',
    // `user:password@host` — the password segment must be non-empty, which is what distinguishes
    // this from an ordinary URL with a port. Group 1 is the secret, so `accept` can look at it.
    re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,64}:([^\s@/]{3,})@[^\s]+/g,
    accept: (m) => !isPlaceholderSecret(m[1] ?? ''),
  },
  {
    kind: 'credential_assignment',
    severity: 'high',
    label: '凭据赋值',
    re: /\b[A-Za-z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Za-z0-9_.-]*\s*[:=]\s*["']?([^\s"']{12,})/g,
  },
  {
    kind: 'credential_assignment',
    severity: 'high',
    label: '凭据赋值（中文）',
    re: /(?:密钥|口令|密码|令牌|凭证)\s*(?:是|为|：|:|=)\s*["'「]?([^\s"'」]{8,})/g,
  },
  {
    kind: 'confidential_marker',
    severity: 'note',
    label: '机密标记',
    // A declaration, not a guess. Only a marker that reads as a classification at the start of a
    // line counts — "这个文件里写着 confidential" in the middle of a sentence is prose ABOUT a
    // marker, and reporting it would be the false positive that teaches people to skip the check.
    re: /^[ \t>]*#{0,6}[ \t]*(?:机密|绝密|内部资料|内部机密|仅供内部使用|CONFIDENTIAL|STRICTLY CONFIDENTIAL)[ \t]*(?:文件|资料|$)/gim,
  },
];

/** Keep the head and tail, drop the middle. Long matches are also capped. */
function mask(match: string): string {
  const flat = match.replace(/\s+/g, ' ').trim();
  if (flat.length <= 12) return flat;
  const head = flat.slice(0, 6);
  const tail = flat.slice(-4);
  return `${head}…${tail}（${flat.length} 字符）`;
}

/**
 * Scan text for anything that must not leave the machine.
 *
 * Overlaps are resolved by keeping the FIRST match at a given offset and skipping the rest: a
 * `connection_string` contains a `Bearer`-shaped fragment in some real DSNs, and reporting one leak
 * three times is how a report stops being read. Ordering the rules matters for the same reason —
 * the most specific shape wins, so `private_key` is checked before anything that could see a
 * fragment of it.
 */
export function scanOutbound(text: string): GuardrailFinding[] {
  if (!text) return [];
  const found: GuardrailFinding[] = [];
  const claimed: Array<[number, number]> = [];
  const overlaps = (start: number, end: number) => claimed.some(([s, e]) => start < e && end > s);

  for (const rule of RULES) {
    // `lastIndex` is state on the RegExp object, and these are module-level: resetting is what keeps
    // a second call from starting where the first one stopped.
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(text); m; m = rule.re.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      /*
       * `accept` runs BEFORE the span is claimed. A rejected hit must not reserve its offsets:
       * otherwise a placeholder DSN would shadow a real credential that overlaps it and neither
       * would be reported — a false negative produced by a false-positive filter.
       */
      if (rule.accept && !rule.accept(m)) continue;
      claimed.push([start, end]);
      found.push({
        kind: rule.kind,
        severity: rule.severity,
        label: rule.label,
        index: start,
        length: m[0].length,
        preview: mask(m[0]),
      });
      // A zero-length match would spin forever; `exec` cannot return one for these rules, but the
      // guard costs nothing and the alternative is a hung turn.
      if (m[0].length === 0) rule.re.lastIndex += 1;
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Just the ones that block a delivery. */
export function highFindings(findings: GuardrailFinding[]): GuardrailFinding[] {
  return findings.filter((f) => f.severity === 'high');
}

/** Counts per kind, for a report that must be readable at a glance. */
export function summariseFindings(findings: GuardrailFinding[]): Array<{ kind: GuardrailKind; label: string; count: number }> {
  const out = new Map<GuardrailKind, { kind: GuardrailKind; label: string; count: number }>();
  for (const f of findings) {
    const hit = out.get(f.kind);
    if (hit) hit.count += 1;
    else out.set(f.kind, { kind: f.kind, label: f.label, count: 1 });
  }
  return [...out.values()];
}

/**
 * Replace every credential-shaped span, for a COPY that is not the answer.
 *
 * Used for the places the same text is duplicated without the user asking: the run trace and the
 * audit record. That is the same rule the trace already applies to tool arguments ("this is a
 * SECOND copy on disk, so a value under a credential-shaped key is replaced") — and it is why this
 * function is separate from the answer path, where nothing is rewritten.
 *
 * Spans are rebuilt from the tail so indices stay valid, and only `high` findings are touched: a
 * `confidential_marker` is a declaration, and removing it from a record would erase the one piece
 * of information that makes the record interpretable.
 */
export function redactForRecord(text: string): string {
  const spans = highFindings(scanOutbound(text)).sort((a, b) => b.index - a.index);
  let out = text;
  for (const f of spans) {
    out = out.slice(0, f.index) + `[已隐去：${f.label}]` + out.slice(f.index + f.length);
  }
  return out;
}

const NOTICE_HEAD = '⚠️ 这条回答里可能有不该外发的内容';

/**
 * What to tell the user, in the turn.
 *
 * Written as an instruction rather than an alarm: the actionable part is "do not forward this",
 * and the finding list has to be readable without the user going to look up what a "JWT" is. It
 * never contains the value — only the masked preview.
 */
export function renderGuardrailNotice(findings: GuardrailFinding[]): string {
  if (!findings.length) return '';
  const lines = summariseFindings(findings).map((s) => `- ${s.label} × ${s.count}`);
  const masked = findings
    .slice(0, 5)
    .map((f) => `  · ${f.label}: ${f.preview}`)
    .join('\n');
  return `${NOTICE_HEAD}（已按文种标出，未改动你的回答）\n${lines.join('\n')}`
    + (masked ? `\n原文片段（已遮罩）：\n${masked}` : '')
    + '\n如果这是你自己的凭据：不要把它转发、贴进 issue 或写进交付文件。';
}

/**
 * What to say when a DELIVERY is refused.
 *
 * Names the offending lines so the model can fix them in the same turn — a refusal that only says
 * "sensitive content" makes the next attempt a guess.
 */
export function renderGuardrailRefusal(findings: GuardrailFinding[]): string {
  const high = highFindings(findings);
  const lines = summariseFindings(high).map((s) => `- ${s.label} × ${s.count}`);
  const masked = high.slice(0, 5).map((f) => `  · ${f.label}: ${f.preview}`).join('\n');
  return `Error: 交付文件里检测到敏感内容，已拒绝写入（${high.length} 处）。\n`
    + `${lines.join('\n')}\n${masked}\n`
    + '交付文件是给别人看的、会被转发和归档的东西，凭据写进去就是一次泄漏。\n'
    + '请把值换成占位符（例如 `<YOUR_API_KEY>`，或只写「见 .env」），然后重试。\n'
    + '如果这确实是需要写进交付的内容（例如你在写密钥轮换文档），显式传 acknowledge_sensitive: true。';
}
