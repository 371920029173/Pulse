import os from 'node:os';
import { basename, resolve, sep } from 'node:path';

/**
 * Path comparison key, matching the server's own spelling-insensitive comparison.
 *
 * Windows hands out the 8.3 short form (`C:\Users\ADMINI~1\…`) from `os.tmpdir()` while the same
 * directory may be spelled long elsewhere, so a raw `===` would call one directory two. Case is
 * folded for the same reason: on Windows `D:\AGI` and `d:\agi` are one directory.
 */
function pathKey(p: string): string {
  const abs = resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * Temporary / test directories that must never become this machine's remembered workspace.
 *
 * The server writes `SHE_WORKSPACE` into the install's real `.env` on every workspace switch, so a
 * relaunch comes back to the project you were in. That is right for a project and wrong for a
 * scratch directory: point the app at one once — by clicking a leftover test folder in the picker,
 * or because a suite switched it — and every later launch starts there, with nothing on screen
 * saying so. Observed 2026-10-01: the app came back up mounted on `D:\AGI\_she-live-test_2` (two
 * throwaway chats) while the user's own project sat on disk, its conversation intact and
 * unreachable from anywhere in the UI.
 *
 * Switching *to* such a directory still works — the suites depend on that, and refusing the mount
 * would break them. Only the persistence is skipped, so the directory is used now and forgotten on
 * restart.
 *
 * Two signals, because neither alone catches the case that was actually hit:
 *   - inside the OS temp directory, which covers every fixture built with `mkdtempSync(tmpdir())`;
 *   - the naming conventions this repo's fixtures use when they deliberately write outside it,
 *     which is exactly what `_she-live-test_2` was.
 *
 * Deliberately not a general "looks like a test" heuristic: a user's own `my-tests/` directory is
 * their project, and refusing to remember it would be the same bug in the other direction.
 */
export function isScratchWorkspace(root: string): boolean {
  const abs = resolve(root);
  const tmp = resolve(os.tmpdir());
  if (pathKey(abs) === pathKey(tmp) || pathKey(abs).startsWith(pathKey(tmp) + sep)) return true;
  /*
   * Anchored to the whole name, and `_she-` needs the hyphen: a user's `she-notes` folder must not
   * be mistaken for a fixture, while `_she-live-test_2` must be.
   */
  return /^(?:_e2e_|_she-|she-(?:safety|rail|restart|encoding|theme|mcp|plugins|schedule|security|turn-lock|host|packag))/i
    .test(basename(abs));
}
