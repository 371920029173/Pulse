/**
 * Shortening a filesystem path so it fits in a label.
 *
 * The UI never gets to assume `node:path`: these strings come from the server and can be Windows
 * paths even when the renderer is not, so splitting on both separators is the only correct reading.
 * (`path.win32`/`path.posix` would each be wrong for the other's input.)
 */

/** Directory separators: `/` and `\`, in that order so a Windows path splits on either. */
const SEPARATORS = /[\\/]+/;

function segments(dir: string): string[] {
  return dir.split(SEPARATORS).filter(Boolean);
}

/**
 * The last `count` path segments, joined with `\`.
 *
 * Two segments is the useful default for "which project is this": the tail distinguishes the cases
 * that actually collide (`Desktop\aaa` versus `Desktop\bbb`), while a full path would be the widest
 * thing in the row. Callers that need to disambiguate two same-named folders should keep the full
 * path in a `title` rather than widening the label.
 *
 * Falls back to the input unchanged when it has no segments (e.g. `/`), because returning an empty
 * label would erase the only clue about where something lives.
 */
export function pathTail(dir: string, count = 2): string {
  const parts = segments(dir);
  if (parts.length === 0) return dir;
  return parts.slice(-count).join('\\');
}
