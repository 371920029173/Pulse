/**
 * Close a modal when the user presses Escape.
 *
 * Several dialogs could only be dismissed by clicking outside them. That leaves a
 * keyboard user with no way out — they can open Settings, the skill library or the
 * session history and then be stuck, because nothing they can press closes it. The
 * backdrop click is a convenience for mouse users, not a substitute for a key.
 *
 * Behaviour that matters:
 *
 *  - **Only the topmost dialog reacts.** Dialogs can be opened over one another (a
 *    confirmation inside a panel), and without this every open dialog would close on
 *    one Escape, which reads as the app dismissing everything at once.
 *
 *  - **Escape is not swallowed when it is not ours.** The listener is registered on
 *    `document` and only calls `preventDefault` when it actually closes something, so
 *    an editor that handles Escape itself keeps working.
 *
 *  - **Focus does not matter.** An input with focus still closes the dialog, matching
 *    every native dialog on both platforms.
 */
import { useEffect, useRef } from 'react';

/**
 * Mounted dialogs, in mount order. The last entry is the topmost.
 *
 * Module-level because the ordering has to be shared between instances; a component
 * cannot see its siblings.
 */
const stack: object[] = [];

/**
 * @param onClose Called when Escape is pressed and this is the topmost dialog.
 * @param enabled Suspend the binding (e.g. while a save is in flight).
 */
export function useEscapeToClose(onClose: (() => void) | undefined, enabled = true): void {
  /** Stable identity for this hook instance, so it removes only its own entry. */
  const token = useRef<object>({});
  /** Latest callback, so a changing `onClose` does not re-register the listener. */
  const latest = useRef(onClose);
  latest.current = onClose;

  useEffect(() => {
    if (!enabled) return;

    const self = token.current;
    stack.push(self);

    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Already handled by something closer (an inline editor cancelling an edit).
      if (event.defaultPrevented) return;
      // Only the topmost dialog responds.
      if (stack[stack.length - 1] !== self) return;

      event.preventDefault();
      latest.current?.();
    };

    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      const at = stack.indexOf(self);
      if (at >= 0) stack.splice(at, 1);
    };
  }, [enabled]);
}
