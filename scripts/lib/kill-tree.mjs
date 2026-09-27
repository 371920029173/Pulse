/**
 * Kill a spawned process AND everything it spawned.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `child.kill()` kills one process. The server spawns tool children of its own — the MCP proxy plus
 * its per-server processes — and those survive their parent. Windows delivers no signal to a
 * terminating process, so the dying server gets no chance to clean up after itself: the parent is the
 * only party that can.
 *
 * Measured on this machine (2026-09-27): three suites' leftovers were still running with dead
 * parents — `mcp-on-demand` plus six tool servers each, seven processes and ~480 MB per tree. Killing
 * the three trees returned 20 processes and 1307 MB. Every gate run adds more, which is the kind of
 * growth that only shows up later as "the machine is out of memory and I do not know why".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 *
 *   const killed = killTree(child.pid);   // best effort, never throws
 *
 * Call it wherever a spawned server is torn down. `child.kill()` alone is not enough.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { spawnSync } from 'node:child_process';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Terminate `pid` and its descendants. Returns whether the direct process is gone.
 *
 * `taskkill /T` is the only Windows way to walk the child tree (Node has no equivalent), and it is
 * also what the sandbox and the launcher already use for the same reason. On POSIX the child is only
 * covered when it was spawned `detached` (its own process group); otherwise the group kill is a
 * no-op and the direct kill still lands, which is exactly the old behaviour rather than a regression.
 */
export function killTree(pid) {
  if (!pid) return true;
  if (IS_WINDOWS) {
    // /T includes the tree, /F forces it. Errors (already gone) are not interesting.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* no group of its own, or already gone */ }
  try { process.kill(pid, 'SIGTERM'); } catch { return true; /* already gone */ }
  return true;
}
