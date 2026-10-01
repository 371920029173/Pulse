/**
 * Temp-directory cleanup that can never fail a check.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * A check that spawns the server holds a SQLite database open under its temp workspace. On Windows,
 * killing the process does not release the file immediately — the handle closes asynchronously — so
 * `rmSync(workspace, { recursive: true, force: true })` intermittently threw:
 *
 *   Error: EBUSY: resource busy or locked, unlink '…\.she\kb.sqlite'
 *
 * Every assertion had already passed, but the throw became the process's exit code, so the gate
 * reported a failure. That is the worst kind of red: it is not reproducible in isolation (running
 * the same check alone passed), so it trains people to re-run until green — and a gate people
 * re-run until green is not a gate.
 *
 * `force: true` does not help: it suppresses ENOENT, not EBUSY.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE
 *
 * Cleanup is not an assertion. A leftover directory in the system temp folder is harmless; a check
 * that reports failure after passing is not. So this retries briefly and then gives up silently.
 *
 * The same rule applies to `after`/`afterEach` hooks in the packages, which cannot import this file
 * (it lives in `scripts/`). Those must therefore retry and then REPORT, never throw — three of them
 * learned this the hard way, all with a spawned child holding the directory: the two sandbox files,
 * and `packages/server/src/__tests__/mcp-bridge.test.ts`. On 2026-09-29 one of them was run while the
 * machine was busy with an unrelated job and turned a fully passing file red (`hookFailed: EBUSY`),
 * which is exactly the "re-run until green" training this module exists to prevent. What they leave
 * behind is collected by `check:temp`.
 *
 * Not using `maxRetries` on `rmSync`: it applies retries per file for EBUSY/EPERM/ENOTEMPTY, but it
 * still throws when the last attempt fails, which is the behaviour that caused the problem.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** How long to keep trying before giving up, in milliseconds. */
const DEADLINE_MS = 3000;
const RETRY_DELAY_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Remove a temp file or directory, retrying while it is locked.
 *
 * Returns whether it succeeded, for the rare caller that wants to report it. Never throws.
 */
export function removeTempDir(target) {
  if (!target) return true;
  const t0 = Date.now();
  for (;;) {
    try {
      rmSync(target, { recursive: true, force: true });
      return true;
    } catch (err) {
      const code = err?.code;
      // EBUSY / EPERM are the transient "still open" cases. Anything else will not improve.
      const transient = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (!transient || Date.now() - t0 > DEADLINE_MS) {
        // A leftover directory is acceptable; failing the check here is not.
        return false;
      }
    }
  }
}

/** `removeTempDir` plus a sleep, for teardown between two servers in one process. */
export async function removeTempDirAsync(target) {
  const ok = removeTempDir(target);
  if (!ok) await sleep(RETRY_DELAY_MS);
  return ok;
}

/** Our own temp workspaces all share this prefix, which is what makes a sweep safe. */
export const TEMP_PREFIX = 'she-';

/** A day is long enough that no run in progress can be within it, short enough to bound the pile. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Remove temp workspaces left behind by PREVIOUS runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `removeTempDir` above refuses to fail a check over a locked directory, and that rule is right — but
 * it was only ever half a system. Nothing removed what it gave up on, so the giving-up accumulated
 * silently. Measured on 2026-09-29: **10,430 directories, 566 MB** in the system temp folder, growing
 * by roughly 500-1,800 a day, because the largest producers are unittest files that `mkdtempSync` a
 * fresh workspace per test case and never delete it (`run-trace` alone had left 5,264).
 *
 * The missing half is a sweep, and it has to be bounded, because this deletes directories:
 *
 *   - only inside the OS temp directory
 *   - only directories (never files)
 *   - only names carrying our prefix — the whole reason the prefix exists
 *   - only entries untouched for a day, so a run in progress (or one started seconds ago from another
 *     terminal) is never a candidate
 *
 * It never throws and never fails a check. Returns what it did so a caller can print it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function sweepStaleTempDirs(opts = {}) {
  const prefix = opts.prefix ?? TEMP_PREFIX;
  const olderThanMs = opts.olderThanMs ?? STALE_AFTER_MS;
  const root = opts.root ?? tmpdir();
  const result = { removed: 0, kept: 0, bytes: 0, root };

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return result;
  }

  const cutoff = Date.now() - olderThanMs;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const target = join(root, entry.name);
    // A directory whose own mtime is recent may still be in use by a run that just made it.
    try {
      if (statSync(target).mtimeMs > cutoff) { result.kept++; continue; }
    } catch {
      continue;
    }
    result.bytes += dirSize(target);
    if (removeTempDir(target)) result.removed++;
    else result.kept++;
  }
  return result;
}

/** Best-effort recursive size, for reporting only. Never throws. */
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(p);
      else if (entry.isFile()) total += statSync(p).size;
    } catch {
      // A file that vanished mid-walk contributes nothing.
    }
  }
  return total;
}
