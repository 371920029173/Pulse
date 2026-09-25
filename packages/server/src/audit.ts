/**
 * Append-only audit trail.
 *
 * The other stores in `.she/` are working state: tickets are a live cache, sessions are rewritten
 * wholesale, plans are edited in place. This one exists for the question asked afterwards —
 * "what did it actually do, and who approved it?" — and that question has a property the others
 * do not: the answer is only worth anything if the record cannot have been edited since. So:
 *
 *   - **Append only.** One JSON object per line, one `appendFileSync` per record. Nothing in this
 *     file rewrites or reorders an existing line, so a line read today reads the same tomorrow.
 *     A store that can be quietly rewritten is a store that records what the current code wants
 *     it to say.
 *   - **Monotonic `seq`.** Timestamps tie (two tools in the same millisecond is ordinary) and a
 *     wall clock can move; a counter that only ever increases gives a total order that survives
 *     rotation, and the check asserts it is strictly increasing.
 *   - **Rotation keeps the history visible.** Past a size limit the file rolls, and if a rotation
 *     has to be dropped to stay bounded, the drop is itself recorded. Deleting audit history
 *     silently would defeat the point of having it.
 *   - **Damage is reported, not hidden.** A line that does not parse — a process killed mid-write
 *     — is skipped when reading and counted, and the count is returned by the API. Silently
 *     returning fewer records would look exactly like "nothing happened".
 *
 * Writes must never break a turn: callers wrap `append` (see `auditSafe` in index.ts). Reading is
 * used by `GET /api/audit`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export type AuditKind =
  | 'request'
  | 'tool'
  | 'confirm'
  /** A rotation dropped old files, and says which. */
  | 'rotation'
  /**
   * A change to the agent's own configuration or self-measurement.
   *
   * Distinct from the three above, which record what the user's request caused. This one records
   * something the agent or the operator changed ABOUT the agent — resetting the confidence mirror is
   * the first of them. It is audited for the same reason a confirmation is: it changes what the
   * agent will do next, so "why is it behaving differently now" has to be answerable afterwards.
   */
  | 'config';

export interface AuditRecord {
  /** Wall clock, for humans. `seq` is what orders records. */
  ts: string;
  /** Strictly increasing within this workspace, across restarts and rotations. */
  seq: number;
  kind: AuditKind;
  session_id?: string;
  /** `request`: what the user asked for. */
  message?: string;
  /** `request`: length before truncation, so a cut record is still measurable. */
  chars?: number;
  truncated?: boolean;
  /** `tool`: which tool, how long, whether it failed. */
  tool?: string;
  ms?: number;
  ok?: boolean;
  /** `confirm`: which ticket, and the answer. */
  ticket_id?: string;
  approved?: boolean;
  /** `rotation`: files dropped to stay bounded. */
  dropped?: string[];
  /** `config`: what was changed. */
  change?: string;
  /** Free-form detail for a kind that needs it. */
  note?: string;
}

export interface AuditReadOptions {
  limit?: number;
  kind?: AuditKind;
  sessionId?: string;
}

export interface AuditReadResult {
  records: AuditRecord[];
  /** Unparseable lines in the files that were read — a crash mid-write, not a normal state. */
  skipped: number;
  /** Files that exist, newest first: the live log plus its rotations. */
  files: string[];
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_KEEP = 5;
/** Longest `message` written; the real length is kept in `chars`. */
const MAX_MESSAGE = 2000;

export class AuditLog {
  private dir: string;
  private file: string;
  private maxBytes: number;
  private keep: number;
  /** Null until read from the file, so a restart continues the same sequence. */
  private seq: number | null = null;

  constructor(root: string, opts: { maxBytes?: number; keep?: number } = {}) {
    this.dir = join(root, '.she');
    this.file = join(this.dir, 'audit.log');
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keep = opts.keep ?? DEFAULT_KEEP;
  }

  /**
   * Rotated files, oldest first.
   *
   * Named `audit-<stamp>-<seq>.log`, so lexical order is chronological and the sequence number
   * keeps two rotations in the same millisecond from colliding.
   */
  private rotations(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.startsWith('audit-') && f.endsWith('.log'))
        .sort()
        .map((f) => join(this.dir, f));
    } catch {
      return [];
    }
  }

  /** Newest first: the live log, then rotations by recency. */
  private readOrder(): string[] {
    const out: string[] = [];
    if (existsSync(this.file)) out.push(this.file);
    for (const f of this.rotations().reverse()) out.push(f);
    return out;
  }

  files(): string[] {
    return this.readOrder().map((f) => basename(f));
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Continue the sequence from whatever is already on disk.
   *
   * Reads the tail of the live file, falling back to the newest rotation if the live log has just
   * been rolled. Starting again from 0 would make the sequence ambiguous across a restart, which
   * is the one thing a reader needs it not to be.
   */
  private ensureSeq(): number {
    if (this.seq !== null) return this.seq;
    const tail = this.parseFile(this.file);
    if (tail.records.length) {
      this.seq = tail.records[tail.records.length - 1].seq;
      return this.seq;
    }
    for (const f of this.rotations().reverse()) {
      const r = this.parseFile(f);
      if (r.records.length) {
        this.seq = r.records[r.records.length - 1].seq;
        return this.seq;
      }
    }
    this.seq = 0;
    return 0;
  }

  private parseFile(path: string): { records: AuditRecord[]; skipped: number } {
    if (!existsSync(path)) return { records: [], skipped: 0 };
    let text: string;
    try {
      text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    } catch {
      /*
       * Unreadable (locked, permissions). Reported as one skipped unit rather than thrown: the
       * caller is usually rendering a list, and "the log exists but could not be read" is a
       * finding, not a reason to return nothing at all.
       */
      return { records: [], skipped: 1 };
    }
    const records: AuditRecord[] = [];
    let skipped = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as AuditRecord;
        if (typeof rec?.seq === 'number' && typeof rec?.kind === 'string') records.push(rec);
        else skipped++;
      } catch {
        // A half-written line from a process that died mid-append.
        skipped++;
      }
    }
    return { records, skipped };
  }

  /**
   * Roll the log when it is too big, and record what that cost.
   *
   * The `rotation` record is written through the same path as everything else, so the trail says
   * "these files were dropped here" instead of the history just starting later than expected.
   */
  private rotateIfNeeded(): void {
    try {
      if (statSync(this.file).size < this.maxBytes) return;
    } catch {
      return; // No file yet, or unreadable: nothing to roll.
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const seq = (this.seq ?? this.ensureSeq()) + 1;
    let target = join(this.dir, `audit-${stamp}-${seq}.log`);
    let n = 1;
    while (existsSync(target)) target = join(this.dir, `audit-${stamp}-${seq}-${n++}.log`);
    renameSync(this.file, target);

    const all = this.rotations();
    const excess = all.slice(0, Math.max(0, all.length - this.keep));
    if (excess.length) {
      for (const f of excess) rmSync(f, { force: true });
      this.seq = seq;
      this.ensureDir();
      const dropped: AuditRecord = {
        ts: new Date().toISOString(),
        seq,
        kind: 'rotation',
        dropped: excess.map((f) => basename(f)),
      };
      appendFileSync(this.file, JSON.stringify(dropped) + '\n', 'utf8');
    }
  }

  /**
   * Append one record. Throws on a real I/O failure; callers decide whether that is fatal.
   *
   * Rotation runs FIRST, and that order is load-bearing: rolling the log can itself append a
   * `rotation` record, and if `seq` were assigned before that, the rotation record and the record
   * that triggered it would both claim the same number. A trail whose ordering is ambiguous in
   * exactly the moment history was dropped is worse than no counter at all.
   */
  append(rec: Omit<AuditRecord, 'ts' | 'seq'>): AuditRecord {
    this.ensureDir();
    this.rotateIfNeeded();
    const full: AuditRecord = { ts: new Date().toISOString(), seq: this.ensureSeq() + 1, ...rec };
    if (typeof full.message === 'string' && full.message.length > MAX_MESSAGE) {
      /*
       * Truncate, and keep the original length. A cut record that does not say it was cut reads as
       * a complete short message, which is worse than a long one.
       */
      full.chars = full.message.length;
      full.truncated = true;
      full.message = full.message.slice(0, MAX_MESSAGE);
    }
    appendFileSync(this.file, JSON.stringify(full) + '\n', 'utf8');
    this.seq = full.seq;
    return full;
  }

  /**
   * Newest first, reading only as much as the limit needs.
   *
   * Files are scanned newest to oldest and the scan stops once `limit` records are in hand, so a
   * UI that asks for 200 records does not read ten megabytes of rotations to find them. Damage is
   * still reported for the part that WAS read: stopping early means the older files went
   * unexamined, which is not the same as them being intact, and silently dropping the count we did
   * observe would make a damaged trail look like a quiet one.
   */
  read(opts: AuditReadOptions = {}): AuditReadResult {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 5000));
    const files = this.readOrder();
    const records: AuditRecord[] = [];
    let skipped = 0;
    for (const f of files) {
      const parsed = this.parseFile(f);
      skipped += parsed.skipped;
      for (let i = parsed.records.length - 1; i >= 0; i--) {
        const rec = parsed.records[i];
        if (opts.kind && rec.kind !== opts.kind) continue;
        if (opts.sessionId && rec.session_id !== opts.sessionId) continue;
        records.push(rec);
      }
      if (records.length >= limit) break;
    }
    return {
      records: records.slice(0, limit),
      skipped,
      files: files.map((f) => basename(f)),
    };
  }
}
