/**
 * Scope a stylesheet to one container.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * The theme editor shows a live preview. The obvious implementation — apply the draft to
 * the document — has a fatal property: the draft can hide the interface, which hides the
 * editor, which means the user cannot undo it from inside the app. Live preview would be
 * a loaded gun pointed at the editor.
 *
 * Scoping the draft to a preview box removes that entirely. `html { display: none }` in a
 * draft previews as *the sample going blank*, the editor stays visible, and the user
 * learns what their rule does without losing the ability to change it.
 *
 * It also makes the real save safer to reason about: the only stylesheet that can affect
 * the whole document is one that has been explicitly saved.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The transform is deliberately simple. It handles the shapes a stylesheet realistically
 * uses — rule sets, media/supports blocks, keyframes, comments, strings — and gives up on
 * anything it cannot rewrite rather than emitting something wrong. Giving up means the
 * rule is dropped from the preview only; the saved file is never modified.
 */

/** The container every selector is scoped under. */
export const PREVIEW_SCOPE = '#she-theme-preview';

interface Block {
  /** The prelude: a selector list, or an at-rule such as `@media (…)`. */
  prelude: string;
  /** Raw body, already extracted. */
  body: string;
  /** True when the body contains nested blocks rather than declarations. */
  nested: boolean;
}

/**
 * Split CSS into top-level blocks.
 *
 * Tracks strings and comments so a `{` inside `content: "{"` or a comment does not change
 * the nesting, which is exactly the bug that makes naive implementations drop half a file.
 */
export function splitBlocks(css: string): { blocks: Block[]; trailing: string } {
  const blocks: Block[] = [];
  let depth = 0;
  let preludeStart = 0;
  let preludeEnd = -1;
  let bodyStart = 0;
  let inString: string | null = null;

  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    // Comments are skipped wholesale so their braces are ignored and their text preserved.
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }

    if (ch === '{') {
      if (depth === 0) {
        preludeEnd = i;
        bodyStart = i + 1;
      }
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && preludeEnd >= 0) {
        const body = css.slice(bodyStart, i);
        blocks.push({
          prelude: css.slice(preludeStart, preludeEnd).trim(),
          body,
          // A nested block is one whose body contains another `{` at depth 0.
          nested: /[^{}]*\{/.test(body),
        });
        preludeStart = i + 1;
        preludeEnd = -1;
      }
      continue;
    }
  }

  return { blocks, trailing: css.slice(preludeStart) };
}

/** Rewrite one selector so it only matches inside the preview container. */
function scopeSelector(selector: string): string {
  const s = selector.trim();
  if (!s) return '';

  /*
   * Document-level selectors become the container itself.
   *
   * `:root` is where custom properties usually live, and the preview box is where those
   * variables need to land — scoping it to `#preview :root` would match nothing, because a
   * descendant of the box can never be the root element.
   */
  const documentLevel = new Set([':root', 'html', 'body', '#root', 'html, body']);
  if (documentLevel.has(s.toLowerCase())) return PREVIEW_SCOPE;

  // `*` becomes "everything inside the box", not literally everything.
  if (s === '*') return `${PREVIEW_SCOPE} *`;

  /*
   * Pseudo-elements on the container itself (`body::before`) would otherwise become
   * `#preview body::before` and match nothing.
   */
  if (/^(html|body)(::?[\w-]+)/.test(s.toLowerCase())) return s.replace(/^(html|body)/i, PREVIEW_SCOPE);

  return `${PREVIEW_SCOPE} ${s}`;
}

/** Rewrite a selector list, dropping entries that cannot be scoped meaningfully. */
function scopeSelectorList(list: string): string {
  return list
    .split(',')
    .map(scopeSelector)
    .filter(Boolean)
    .join(', ');
}

/**
 * Split a prelude into leading comments and the actual selector.
 *
 * A comment sitting above a rule lands inside the prelude slice, and prefixing the whole
 * slice produced `#preview /* note *​/ .a` — valid CSS (a comment is whitespace between
 * selector components) but the comment no longer reads as a note above the rule, and any
 * comparison of selectors has to account for it. Emitting comments separately keeps the
 * output predictable.
 */
export function splitPrelude(prelude: string): { comments: string[]; selector: string } {
  const comments: string[] = [];
  let rest = prelude;
  for (;;) {
    const m = /^\s*(\/\*[\s\S]*?\*\/)/.exec(rest);
    if (!m) break;
    comments.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  return { comments, selector: rest.trim() };
}

/**
 * Rewrite a stylesheet so every rule only matches inside the preview container.
 *
 * Keyframes are passed through untouched: animation names are global by design, and a
 * keyframe block has no selector to scope.
 */
export function scopeCss(css: string): string {
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
      if (name === 'import' || name === 'charset' || name === 'namespace') {
        // At-rules without a block; dropped from the preview (remote loads are refused on
        // save anyway).
        continue;
      }
      // `@media`, `@supports`, `@layer`, `@container`: recurse into the body so the inner
      // selectors get scoped too.
      out.push(`${lead}${selector} {\n${scopeCss(block.body)}\n}`);
      continue;
    }

    const scoped = scopeSelectorList(selector);
    if (!scoped) continue;
    out.push(`${lead}${scoped} {${block.body}}`);
  }

  return out.join('\n');
}

/**
 * Count the rules a browser actually parsed from a stylesheet element.
 *
 * A file that produces zero rules from non-empty input is a syntax error in practice, so
 * the editor reports it rather than leaving the user to wonder why nothing changed.
 */
export function parsedRuleCount(el: HTMLStyleElement | null): number {
  if (!el) return 0;
  try {
    return (el.sheet as CSSStyleSheet | null)?.cssRules?.length ?? 0;
  } catch {
    return 0;
  }
}
