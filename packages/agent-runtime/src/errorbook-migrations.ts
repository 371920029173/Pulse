/**
 * Retiring error-book entries that a since-fixed checker wrote by mistake.
 *
 * `reflection_check` files its verdicts into the error book (`errors/自省`), and the book replays
 * them as lessons. When the CHECKER turns out to have been wrong — and the bug is fixed — the
 * entries it already wrote are still there, still accusing the agent of the thing the fix just
 * proved it did not do. Nothing else will clean them up: the fixed checker simply stops writing new
 * ones, and an old entry only leaves the book when someone calls `errorbook_forget` on it.
 *
 * So this runs once per knowledge base per registry version, at startup, and retires (never
 * deletes) the entries whose recorded evidence matches a KNOWN, FIXED false-positive shape. It goes
 * through `ErrorBook.forget`, so a retired entry stays on disk, says why it was retired, and comes
 * back by itself if the same verdict is ever produced again by the fixed code.
 *
 * Which way it is allowed to be wrong: towards keeping. An entry is retired only when EVERY signal
 * in its evidence is parsed and recognised as one of the fixed false positives; anything unparsed,
 * truncated past recognition, or matching a genuine violation keeps the entry live.
 *
 * Adding a new fixed false positive: add one entry to `KNOWN_FALSE_POSITIVES` and bump
 * `FALSE_POSITIVE_REGISTRY_VERSION`, so every workspace runs the sweep once more.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ErrorBook, ERRORBOOK_ROOT } from './errorbook.js';
import type { ErrorbookEngineLike, ErrorbookStoreLike } from './errorbook.js';
import { prohibitionObject } from './reflection.js';

// ─── Evidence parsing ───────────────────────────────────────────────────────

/** One signal recovered from a stored `reflection` entry's evidence (`errorCall`). */
export type EvidenceSignal =
  | { kind: 'constraint'; constraint: string; object: string; via: string }
  | { kind: 'goal_unrelated'; actions: number | null }
  | { kind: 'step_off_goal' }
  | { kind: 'budget_overrun' };

/*
 * The exact wordings `detectDrift` writes (reflection.ts). Sticky, so the parser can require that
 * the WHOLE evidence is made of recognised signals rather than finding one somewhere inside it.
 */
const SIGNAL_PATTERNS: { kind: EvidenceSignal['kind']; re: RegExp }[] = [
  { kind: 'constraint', re: /约束「([\s\S]*?)」排除的对象「([^「」]*)」出现在了 (\S+) 的调用参数里/y },
  { kind: 'goal_unrelated', re: /最近 ([35]) 个动作没有提到目标里的任何词（目标词如：[^）]*）/y },
  { kind: 'step_off_goal', re: /当前步骤「[\s\S]*?」没有提到目标里的任何词/y },
  { kind: 'budget_overrun', re: /已用 \d+ 次工具调用，超过预算的 \d+ 次/y },
];

/**
 * Split stored evidence back into the signals `detectDrift` produced.
 *
 * Evidence is the signal details joined with '；', whitespace-collapsed and cut at 200 characters
 * with a trailing '…' (`ErrorBook.recordReflection`). A cut tail is accepted only when enough of it
 * survives to say which signal it was; otherwise the whole evidence is "unparsed" (null), and an
 * unparsed entry is never retired.
 */
export function parseReflectionEvidence(evidence: string): EvidenceSignal[] | null {
  const text = String(evidence ?? '').trim();
  const truncated = text.endsWith('…');
  const body = truncated ? text.slice(0, -1) : text;
  const out: EvidenceSignal[] = [];
  let pos = 0;
  while (pos < body.length) {
    while (pos < body.length && /[；;\s]/.test(body[pos])) pos++;
    if (pos >= body.length) break;
    let matched = false;
    for (const { kind, re } of SIGNAL_PATTERNS) {
      re.lastIndex = pos;
      const m = re.exec(body);
      if (!m) continue;
      if (kind === 'constraint') out.push({ kind, constraint: m[1], object: m[2], via: m[3] });
      else if (kind === 'goal_unrelated') out.push({ kind, actions: Number(m[1]) });
      else out.push({ kind } as EvidenceSignal);
      pos = re.lastIndex;
      matched = true;
      break;
    }
    if (matched) continue;
    if (!truncated) return null;
    // The cut-off last signal.
    const tail = body.slice(pos);
    const partialConstraint = /^约束「([\s\S]*?)」排除的对象「([^「」]*)」/.exec(tail);
    if (partialConstraint) out.push({ kind: 'constraint', constraint: partialConstraint[1], object: partialConstraint[2], via: '' });
    else if (/^最近 /.test(tail)) {
      const n = /^最近 ([35]) /.exec(tail);
      out.push({ kind: 'goal_unrelated', actions: n ? Number(n[1]) : null });
    } else if (/^当前步骤「/.test(tail)) out.push({ kind: 'step_off_goal' });
    else return null;
    break;
  }
  return out.length ? out : null;
}

/**
 * Where an allow-list starts inside a clause: "只用 kb_* 工具", "仅通过 X", "only use X".
 * Kept in step with `WHITELIST_START` in reflection.ts, deliberately narrower (no "允许/例外"):
 * this decides what to RETIRE, so it only recognises the phrasing the fix was about.
 */
const ALLOW_LIST_START = /(?=只(?:用|能用|使用|许用|准用|走|通过|调用)|仅(?:用|使用|通过)|\buse\s+only\b|\bonly\s+use\b)/i;
const ALLOW_LIST_HEAD = /^(只(?:用|能用|使用|许用|准用|走|通过|调用)|仅(?:用|使用|通过)|use\s+only|only\s+use)/i;

/**
 * True when a recorded constraint violation is the fixed allow-list false positive.
 *
 * Both have to hold:
 *   1. re-evaluated with the CURRENT parser (`prohibitionObject`), the constraint no longer
 *      forbids the reported object — so the fixed check would not raise it again;
 *   2. the reported object literally sits inside an allow-list clause of the constraint — so the
 *      old accusation came from the permitted half, which is the bug that was fixed.
 * A genuine violation (the object is what the prohibition names, e.g. `.she/kb.sqlite` read via
 * `shell`) fails (1) and is kept.
 */
export function isAllowListConstraintFalsePositive(constraint: string, object: string): boolean {
  const obj = String(object ?? '').trim().toLowerCase();
  const core = obj.replace(/\*+$/, '');
  if (core.length < 2) return false;
  const forbidden = prohibitionObject(constraint).map((o) => o.toLowerCase());
  if (forbidden.some((o) => o === obj || o.includes(core) || core.includes(o))) return false;
  const allowClauses = String(constraint ?? '')
    .split(/[，,；;。!！?？\n]+/)
    .flatMap((p) => p.split(ALLOW_LIST_START))
    .map((p) => p.trim())
    .filter((p) => ALLOW_LIST_HEAD.test(p));
  return allowClauses.some((c) => c.toLowerCase().includes(core));
}

// ─── Registry ───────────────────────────────────────────────────────────────

/** What a matcher sees: the fields of one stored entry. */
export interface StoredErrorEntry {
  id: string;
  kind: string;
  /** The tool column; for a reflection, its topic (`目标漂移`, `越过约束`, …). */
  tool: string;
  /** For a reflection, the evidence. */
  call: string;
  detail: string;
  lastSeenAt: string;
}

export interface KnownFalsePositive {
  /** Stable id; quoted in the retire reason and the log. */
  id: string;
  /** The release the checker was fixed in. */
  fixedIn: string;
  description: string;
  matches: (entry: StoredErrorEntry) => boolean;
}

/**
 * Bump when a signature is added or a matcher changes, so every KB is swept once more.
 * The marker records the version it ran at; a lower one means "not yet".
 */
export const FALSE_POSITIVE_REGISTRY_VERSION = 1;

export const KNOWN_FALSE_POSITIVES: KnownFalsePositive[] = [
  {
    id: 'reflection-allowlist-constraint',
    fixedIn: '0.3.1',
    description: '越过约束：allow-list phrasing ("只用 kb_* 工具") was read as the excluded object, so the agent was '
      + 'accused of violating a constraint by using the tools it named as allowed.',
    matches: (e) => {
      if (e.kind !== 'reflection' || e.tool !== '越过约束') return false;
      const signals = parseReflectionEvidence(e.call);
      if (!signals || !signals.every((s) => s.kind === 'constraint')) return false;
      return signals.every((s) => s.kind === 'constraint' && isAllowListConstraintFalsePositive(s.constraint, s.object));
    },
  },
  {
    id: 'reflection-lexical-drift',
    fixedIn: '0.3.1',
    description: '目标漂移：lexical drift verdicts ("最近 5 个动作没有提到目标里的任何词", "当前步骤…没有提到目标里的任何词") '
      + 'that fired on tool-less labels, bookkeeping calls and plan-step paraphrases — typically reported as 已漂移 1.00.',
    matches: (e) => {
      if (e.kind !== 'reflection' || e.tool !== '目标漂移') return false;
      const signals = parseReflectionEvidence(e.call);
      if (!signals) return false;
      // Every signal must be one of the fixed classes; a budget overrun or a genuine constraint
      // violation is a real reason for the drift verdict and keeps the entry.
      const allFixed = signals.every((s) => s.kind === 'goal_unrelated' || s.kind === 'step_off_goal'
        || (s.kind === 'constraint' && isAllowListConstraintFalsePositive(s.constraint, s.object)));
      if (!allFixed) return false;
      // A drift verdict needs a major signal; it must be one of the fixed ones.
      return signals.some((s) => (s.kind === 'goal_unrelated' && s.actions === 5) || s.kind === 'constraint');
    },
  },
];

/** The first registry signature an entry matches, or null. */
export function matchKnownFalsePositive(
  entry: StoredErrorEntry,
  registry: KnownFalsePositive[] = KNOWN_FALSE_POSITIVES,
): KnownFalsePositive | null {
  for (const sig of registry) {
    try {
      if (sig.matches(entry)) return sig;
    } catch {
      // A broken matcher keeps the entry; it never takes the sweep down.
    }
  }
  return null;
}

// ─── Marker ─────────────────────────────────────────────────────────────────

/** Where the once-per-KB marker lives: `<workspace>/.she/migrations.json`. */
export function migrationsMarkerPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.she', 'migrations.json');
}

const MARKER_KEY = 'errorbook_known_false_positives';

interface MarkerRun { registryVersion: number; ranAt: string; retired: string[] }
type MarkerFile = Record<string, unknown> & { [MARKER_KEY]?: Record<string, MarkerRun> };

function readMarker(path: string): MarkerFile {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as MarkerFile : {};
  } catch {
    return {};
  }
}

function writeMarker(path: string, data: MarkerFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.migrations-${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, path);
}

/** The key a KB is recorded under: its resolved path, case-folded on Windows. */
function kbKey(dbPath: string): string {
  const abs = resolve(dbPath);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

// ─── Sweep ──────────────────────────────────────────────────────────────────

export interface RetireKnownFalsePositivesOptions {
  /** Workspace whose `.she/migrations.json` holds the marker. */
  workspaceRoot: string;
  /** The KB being swept; the marker is per KB, since that is where the entries live. */
  kbPath: string;
  log?: { info: (msg: string) => void; warn: (msg: string) => void };
  registry?: KnownFalsePositive[];
  registryVersion?: number;
}

export interface RetireKnownFalsePositivesResult {
  /** 'skipped' when the marker says this KB was already swept at this registry version. */
  status: 'ran' | 'skipped' | 'failed';
  retired: { id: string; signature: string }[];
  error?: string;
}

/**
 * Sweep one KB for known, fixed false positives and retire them. Never throws.
 */
export function retireKnownFalsePositives(
  engine: ErrorbookEngineLike,
  store: ErrorbookStoreLike,
  opts: RetireKnownFalsePositivesOptions,
): RetireKnownFalsePositivesResult {
  const registry = opts.registry ?? KNOWN_FALSE_POSITIVES;
  const version = opts.registryVersion ?? FALSE_POSITIVE_REGISTRY_VERSION;
  const retired: { id: string; signature: string }[] = [];
  try {
    const markerPath = migrationsMarkerPath(opts.workspaceRoot);
    const key = kbKey(opts.kbPath);
    const marker = readMarker(markerPath);
    const runs = (marker[MARKER_KEY] && typeof marker[MARKER_KEY] === 'object') ? marker[MARKER_KEY]! : {};
    if (Number(runs[key]?.registryVersion ?? 0) >= version) return { status: 'skipped', retired };

    // Read-only walk of `errors/*`, including already-retired entries (skipped below).
    const root = store.getAllGroups().find((g) => g.name === ERRORBOOK_ROOT && g.parentGroupId === null);
    const candidates: { entry: StoredErrorEntry; sig: KnownFalsePositive }[] = [];
    if (root) {
      for (const g of store.getAllGroups().filter((x) => x.parentGroupId === root.id)) {
        for (const m of store.getMemoriesByGroup(g.id)) {
          const md = m.metadata ?? {};
          if (md.errorbook !== true || md.errorForgotten === true) continue;
          const entry: StoredErrorEntry = {
            id: m.id,
            kind: String(md.errorKind ?? ''),
            tool: String(md.errorTool ?? ''),
            call: String(md.errorCall ?? ''),
            detail: String(md.errorDetail ?? ''),
            lastSeenAt: String(md.errorLastSeenAt ?? ''),
          };
          const sig = matchKnownFalsePositive(entry, registry);
          if (sig) candidates.push({ entry, sig });
        }
      }
    }

    const book = new ErrorBook(engine, store);
    for (const { entry, sig } of candidates) {
      const done = book.forget(entry.id, `known false positive fixed in v${sig.fixedIn}: ${sig.id}`);
      if (done && !done.already) retired.push({ id: entry.id, signature: sig.id });
    }

    runs[key] = { registryVersion: version, ranAt: new Date().toISOString(), retired: retired.map((r) => r.id) };
    marker[MARKER_KEY] = runs;
    try {
      writeMarker(markerPath, marker);
    } catch (err) {
      // Without the marker the sweep simply runs again next start, and finds nothing new.
      opts.log?.warn(`errorbook migration: could not write marker ${markerPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (retired.length) {
      opts.log?.info(`errorbook migration: retired ${retired.length} known false positive(s): `
        + retired.map((r) => `${r.id} (${r.signature})`).join(', '));
    } else {
      opts.log?.info('errorbook migration: no known false positives found');
    }
    return { status: 'ran', retired };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.log?.warn(`errorbook migration failed (startup continues): ${msg}`);
    return { status: 'failed', retired, error: msg };
  }
}
