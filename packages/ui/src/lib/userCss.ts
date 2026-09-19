/**
 * Make the user's document-level selectors authoritative.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 *
 * The headline promise of the stylesheet feature is that overriding a few variables in
 * `:root` restyles the app. That promise was false in half the cases:
 *
 *   :root           { --accent: #58a6ff }   ← dark  defaults, specificity (0,1,0)
 *   [data-theme="light"] { --accent: #0969da }   ← light overrides,  specificity (0,1,1)
 *
 * A user writing `:root { --accent: #ff7a59 }` therefore won in dark mode (same specificity,
 * later in the cascade) and silently lost in light mode. Failing in one theme only is the
 * worst shape a bug can take here: it reads as "the feature is broken" rather than as "your
 * selector is not specific enough", and the user has no way to see why.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FIX
 *
 * Promote `:root` and `html` in the user's sheet to also match `html[data-theme]`, which has
 * the same specificity as the app's themed blocks. The injected sheet is appended last, so it
 * wins every tie:
 *
 *   :root, html[data-theme] { --accent: #ff7a59 }
 *
 * Applied at injection time, not to the file. The file keeps exactly what the user wrote —
 * rewriting their source would be a surprise, and it has to stay readable and editable by
 * hand.
 *
 * Only these two selectors are promoted. A user overriding `.someClass` still competes on
 * normal CSS rules, which is what anyone writing selectors expects; the trap was specific to
 * `:root`, where the convention says "this is how you set a variable" and the outcome
 * contradicted it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { splitBlocks, splitPrelude } from './scopeCss';

/** The selectors that mean "the document root", which is what the app themes. */
const DOCUMENT_LEVEL = new Set([':root', 'html']);

/** The specificity-raising companion added to those selectors. */
const COMPANION = 'html[data-theme]';

/** Whether a selector list already contains the companion, so it is not added twice. */
function hasCompanion(list: string): boolean {
  return list.split(',').some((s) => s.trim().toLowerCase() === COMPANION);
}

/** Rewrite one selector list, promoting document-level entries. */
export function promoteSelectorList(list: string): { selector: string; changed: boolean } {
  const parts = list.split(',').map((s) => s.trim()).filter(Boolean);
  let changed = false;
  const out: string[] = [];

  for (const part of parts) {
    out.push(part);
    if (DOCUMENT_LEVEL.has(part.toLowerCase())) {
      changed = true;
    }
  }

  // Append the companion once, only if the list targets the root.
  if (changed && !hasCompanion(list)) out.push(COMPANION);
  return { selector: out.join(', '), changed };
}

/**
 * Promote document-level selectors throughout a stylesheet.
 *
 * Recurses into conditional group rules (`@media`, `@supports`) because a themed override
 * inside a media query needs the same treatment. `@keyframes` is skipped: its inner blocks
 * are keyframe selectors (`from`, `50%`), not element selectors.
 */
export function promoteDocumentSelectors(css: string): string {
  const { blocks } = splitBlocks(css);
  const out: string[] = [];

  for (const block of blocks) {
    const { comments, selector } = splitPrelude(block.prelude);
    const lead = comments.length ? `${comments.join('\n')}\n` : '';
    if (!selector) continue;

    if (selector.startsWith('@')) {
      const name = selector.slice(1).split(/[\s({]/)[0].toLowerCase();
      if (name === 'keyframes' || name.endsWith('keyframes')) {
        out.push(`${lead}${selector} {${block.body}}`);
        continue;
      }
      if (name === 'import' || name === 'charset' || name === 'namespace') continue;
      out.push(`${lead}${selector} {\n${promoteDocumentSelectors(block.body)}\n}`);
      continue;
    }

    const { selector: promoted } = promoteSelectorList(selector);
    out.push(`${lead}${promoted} {${block.body}}`);
  }

  return out.join('\n');
}
