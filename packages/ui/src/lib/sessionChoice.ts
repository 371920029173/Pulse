/**
 * Which conversation a window should be showing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SEPARATE, TESTABLE FUNCTION
 *
 * The server keeps exactly ONE active session. Every request carries an explicit
 * `session_id`, so that global value is only a hint — but the UI treated it as an instruction
 * and re-adopted it on every refresh (which happens on both edges of every turn). The result
 * was that the conversation a window was reading could be swapped out from under the user:
 *
 *   - a second window selecting its own chat pulled this one over;
 *   - a scheduled task running headlessly activated the session it works in, and the user's
 *     window followed it there mid-sentence.
 *
 * The rule is small enough to state exactly, and stating it exactly is the point: "adopt the
 * server's choice only when this window has not made one". As an inline expression inside a
 * component that expression is not directly testable, and this is a rule that failed silently
 * for a long time — so it lives here, with tests.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Decide the active session after a fresh session list arrives.
 *
 * @param local       what this window has selected (null = it has no opinion)
 * @param inCluster   whether this window is showing a work group instead of a single chat
 * @param serverActive the server's global active session, a hint for a window with no opinion
 */
export function pickActiveSession(
  local: string | null,
  inCluster: boolean,
  serverActive: string | null,
): string | null {
  // A window is either reading one conversation or a work group, never both. While a work
  // group is open, the single-chat selection is deliberately empty — adopting the server's
  // value there would set a session behind the group and resurrect it when the group closes.
  if (inCluster) return null;

  // The whole rule: an existing local choice wins. It is this window's decision.
  if (local !== null) return local;

  // No local choice — a fresh window, or a reload with nothing stored. Start where the server
  // says the user left off.
  return serverActive;
}

/**
 * Whether a stored session id is still usable.
 *
 * A restored selection can be stale: the conversation may have been deleted from another
 * window. Using it would show an empty transcript with no explanation, so it is dropped and
 * the window falls back to adopting the server's choice.
 *
 * `known` being empty is NOT evidence of staleness — it means the list has not loaded yet, and
 * clearing on that basis would discard a perfectly good selection on every reload.
 */
export function isSessionKnown(local: string | null, known: readonly string[]): boolean {
  if (!local) return true;
  if (known.length === 0) return true;
  return known.includes(local);
}
