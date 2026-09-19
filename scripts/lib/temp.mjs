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
 * Not using `maxRetries` on `rmSync`: it applies retries per file for EBUSY/EPERM/ENOTEMPTY, but it
 * still throws when the last attempt fails, which is the behaviour that caused the problem.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { rmSync } from 'node:fs';

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
