/**
 * The independent critic: check a claim against what actually ran.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT ANOTHER LLM CALL
 *
 * The obvious shape for "critic" is a second model reading the first model's answer, and it has a
 * failure mode that is invisible from the outside: the critic is asked "is this good?", has no more
 * information than the author did, and answers with the same fluent confidence. Two models agreeing
 * is not corroboration when the second one has nothing the first one lacked.
 *
 * What DID happen is on disk. Every tool call in this workspace is in `.she/runs/*.jsonl` with its
 * arguments, its output and the classifier's verdict, so the one thing an honest critic can do
 * better than the author is compare a claim to the record. That is what this file does, and it can
 * do it without a model at all.
 *
 * So: a claim that says a tool ran is checked against the trace; a claim that quotes output is
 * checked against the output that was actually produced. A claim with neither is reported as
 * `unverifiable` and does NOT change the verdict — the critic only speaks about what it can check,
 * and pretending to judge the rest is how a critic becomes a rubber stamp.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE VERDICT IS DELIBERATELY HARSH
 *
 * `contradicted` (the claim says a tool succeeded and its last run failed) is a `fail`. That is not
 * a stylistic opinion: it is the one case where the record proves the claim wrong, and delivering
 * it to the user is the exact failure this project keeps finding — see the "not verified is not
 * done" rule in the delivery template, which this enforces with evidence instead of with a promise.
 *
 * `unbacked` (a tool claim with no matching run, or evidence tokens that appear nowhere) is only
 * `concerns`, because a genuine quote can be paraphrased or taken from a file rather than from
 * output, and a critic that fails an answer over a paraphrase is one the agent will route around.
 */
import { distinctTokens } from './run-trace.js';
import type { RunEvent, RunReadResult } from './run-trace.js';

export type CriticStatus = 'backed' | 'unbacked' | 'contradicted' | 'unverifiable';

export type CriticVerdict = 'pass' | 'concerns' | 'fail';

export interface CriticClaim {
  /** The sentence being checked. */
  text: string;
  /** The tool the claim says was used, when it names one. */
  tool?: string;
  /** Output the claim quotes, when it quotes any. */
  evidence?: string;
}

export interface CriticFinding {
  claim: string;
  status: CriticStatus;
  /** Why, in the terms the check used. */
  detail: string;
  /** Which tool run this was checked against, when one matched. */
  matchedRun?: string;
}

export interface CriticReview {
  verdict: CriticVerdict;
  findings: CriticFinding[];
  /** Tool calls found in the record this review looked at. */
  toolRuns: number;
  /** How many claims were actually checkable — the denominator behind the verdict. */
  checked: number;
  /** One line for a receipt or the room transcript. */
  summary: string;
}

/**
 * Words that assert an outcome rather than describe a plan.
 *
 * Used only to split a block of prose into claim-sized pieces, so a paragraph does not become one
 * giant claim that fails as a unit. The list is short and observable; sentence splitting below does
 * the rest of the work.
 */
const ASSERTION = /(已|已经|都|全部|通过了|跑通|修好了|修复了|验证过|确认过|完成|成功|passed|all green|fixed|verified)/i;

/** Split a delivery text into claims: sentences, further split on line and list boundaries. */
export function extractClaims(text: string): string[] {
  return String(text ?? '')
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[。！？!?;；])\s*/))
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.、)]|#{1,6})\s*/, '').trim())
    .filter((s) => s.length >= 4 && ASSERTION.test(s));
}

/** Tool names are matched as whole tokens, so `read` does not match `read_file` inside other words. */
function mentionsTool(text: string, tool: string): boolean {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`).test(text);
}

/** A token that looks like an artifact: a path, a command, an identifier, a version. */
const ARTIFACT_TOKEN = /[/\\:._@-]/;
const CJK = /[\u4e00-\u9fff]/;

/**
 * The tokens in a claim that could serve as evidence, if they were quoted from output.
 *
 * `distinctTokens` is the shared vocabulary (same stoplist, same minimum length), with the critic's
 * own filter on top — and the filter is the part that matters, because a word is not a citation:
 *
 *   - **no CJK.** Chinese prose has no word separators, so a six-character run is the ordinary unit
 *     of a sentence rather than a quote. The delivery check in `run-trace.ts` can afford to match
 *     them because it only ever reads evidence LINES; the critic reads whole answers, where matching
 *     prose against prose would report every paragraph as uncorroborated.
 *   - **ASCII only when it is artifact-shaped** — it carries a path/command/version marker, or it is
 *     long enough (8+) that it cannot be an ordinary word. "shell 已跑通" names a tool, which is
 *     already checked above; treating `shell` as quoted evidence would make that claim fail for
 *     having quoted the name of the thing it claims to have run.
 */
function evidenceTokens(text: string): string[] {
  return distinctTokens(text).filter((t) => !CJK.test(t) && (ARTIFACT_TOKEN.test(t) || t.length >= 8));
}

function eventsOf(input: RunReadResult | { events: RunEvent[] } | RunEvent[]): RunEvent[] {
  return Array.isArray(input) ? input : input.events;
}

/**
 * Compare claims against a run trace.
 *
 * `input` is whatever the caller has: the events of the run being reviewed, or a `RunReadResult`
 * read back from disk. Both are accepted because the live path has the recorder's events in hand and
 * the review path has a file, and making the caller reshape one into the other would be the kind of
 * adapter that quietly drops fields.
 */
export function reviewClaims(input: {
  claims: (string | CriticClaim)[];
  trace: RunReadResult | { events: RunEvent[] } | RunEvent[];
  /** Tool names the agent had. A claim naming a tool outside this list is unbacked by definition. */
  availableTools?: string[];
}): CriticReview {
  const events = eventsOf(input.trace);
  const toolEvents = events.filter((e) => e.kind === 'tool' && !!e.tool);
  const claims: CriticClaim[] = input.claims.map((c) => (typeof c === 'string' ? { text: c } : c));
  const findings: CriticFinding[] = [];
  /*
   * Tool names are removed from the evidence tokens below.
   *
   * Which tool ran is already decided by the two checks above, so a tool's NAME cannot also be the
   * proof that it ran — that is circular, and it would fail exactly the claims that are most precise
   * ("fs_read 已经读到了配置"). Only the tools this run knows about are removed, so an unknown
   * identifier in a claim is still checked against the output.
   */
  const knownTools = new Set([
    ...toolEvents.map((e) => e.tool!.toLowerCase()),
    ...(input.availableTools ?? []).map((t) => t.toLowerCase()),
  ]);

  for (const claim of claims) {
    const tool = claim.tool
      ?? [...new Set(toolEvents.map((e) => e.tool!))].find((t) => mentionsTool(claim.text, t))
      ?? input.availableTools?.find((t) => mentionsTool(claim.text, t));

    const runs = tool ? toolEvents.filter((e) => e.tool === tool) : [];
    const last = runs[runs.length - 1];

    // ── 1. The claim names a tool that never ran ──
    if (tool && !last) {
      findings.push({
        claim: claim.text,
        status: 'unbacked',
        detail: `说法里点名了工具 ${tool}，但这一轮的运行轨迹里没有它的任何调用记录`,
      });
      continue;
    }

    // ── 2. The claim's tool ran and its last run failed ──
    /*
     * Only when the claim also asserts success — `asserts` is true for every claim that got here,
     * because `extractClaims` keeps only those. This is the one finding that is a proof rather than
     * a suspicion, so it is reported with the failure kind the classifier assigned.
     */
    if (last && last.ok === false) {
      findings.push({
        claim: claim.text,
        status: 'contradicted',
        detail: `说法称 ${tool} 已完成，但轨迹里它最后一次调用是失败的（${last.failure ?? '未分类'}）：${String(last.result ?? '').slice(0, 160)}`,
        matchedRun: `${tool}#${last.seq}`,
      });
      continue;
    }

    // ── 3. Quoted evidence, checked against everything the run actually produced ──
    const quoted = claim.evidence ?? claim.text;
    const tokens = evidenceTokens(quoted).filter((t) => !knownTools.has(t.toLowerCase()));
    if (tokens.length) {
      const haystack = toolEvents
        .map((e) => `${e.args ?? ''}\n${e.result ?? ''}`)
        .join('\n');
      const hits = tokens.filter((t) => haystack.includes(t));
      if (hits.length) {
        findings.push({
          claim: claim.text,
          status: 'backed',
          detail: `引用的内容在轨迹里能找到（${hits.slice(0, 3).join('、')}）`,
          matchedRun: last ? `${last.tool}#${last.seq}` : undefined,
        });
      } else {
        findings.push({
          claim: claim.text,
          status: 'unbacked',
          detail: `引用的内容在轨迹里找不到：${tokens.slice(0, 5).join('、')}`,
          matchedRun: last ? `${last.tool}#${last.seq}` : undefined,
        });
      }
      continue;
    }

    // ── 4. Nothing checkable ──
    /*
     * A tool ran, but the claim neither quotes output nor names a token long enough to look for.
     * Reported so the reader can see it was considered, and excluded from the verdict — this is the
     * critic declining to have an opinion, which is different from approving.
     */
    findings.push({
      claim: claim.text,
      status: 'unverifiable',
      detail: last
        ? `${last.tool} 确实调用过，但这个说法没有引用任何可核对的内容`
        : '这个说法没有点名工具，也没有引用任何可核对的内容',
      matchedRun: last ? `${last.tool}#${last.seq}` : undefined,
    });
  }

  const contradictory = findings.filter((f) => f.status === 'contradicted');
  const unbacked = findings.filter((f) => f.status === 'unbacked');
  const checked = findings.filter((f) => f.status !== 'unverifiable').length;
  const verdict: CriticVerdict = contradictory.length ? 'fail' : unbacked.length ? 'concerns' : 'pass';

  return {
    verdict,
    findings,
    toolRuns: toolEvents.length,
    checked,
    summary: criticSummary(verdict, findings, toolEvents.length),
  };
}

/**
 * One line.
 *
 * `pass` says what it did NOT cover, because "passed" from a checker that only had one claim to look
 * at reads as "everything is fine", and that is the misreading this summary exists to prevent.
 */
function criticSummary(verdict: CriticVerdict, findings: CriticFinding[], toolRuns: number): string {
  const contradicted = findings.filter((f) => f.status === 'contradicted').length;
  const unbacked = findings.filter((f) => f.status === 'unbacked').length;
  const unverifiable = findings.filter((f) => f.status === 'unverifiable').length;
  const head = verdict === 'fail'
    ? `批评者：不通过——${contradicted} 条说法与运行轨迹矛盾（轨迹里这些调用是失败的）。`
    : verdict === 'concerns'
      ? `批评者：有保留——${unbacked} 条说法在轨迹里找不到依据。`
      : '批评者：这一轮没有发现与轨迹矛盾的说法。';
  const tail = unverifiable
    ? `另有 ${unverifiable} 条无法核对（既没点名工具也没引用输出），不计入结论。`
    : '';
  return [head, `依据：本轮 ${toolRuns} 次工具调用。`, tail].filter(Boolean).join(' ');
}

/** The findings a caller has to act on, worst first. */
export function actionableFindings(review: CriticReview): CriticFinding[] {
  const rank: Record<CriticStatus, number> = { contradicted: 0, unbacked: 1, backed: 2, unverifiable: 3 };
  return review.findings.filter((f) => f.status === 'contradicted' || f.status === 'unbacked')
    .sort((a, b) => rank[a.status] - rank[b.status]);
}

/**
 * The block a delivery or a room gets, or an empty string.
 *
 * Empty on `pass` with nothing actionable: a critic that writes "all clear" into every transcript
 * trains its reader to skip the section, which costs the one time it matters.
 */
export function renderCriticReview(review: CriticReview): string {
  const actionable = actionableFindings(review);
  if (!actionable.length) return '';
  return [
    review.summary,
    ...actionable.map((f) => `- [${f.status}] ${f.claim}\n  → ${f.detail}`),
  ].join('\n');
}
