/**
 * User stylesheet.
 *
 * The whole UI is built on CSS custom properties (`--bg-primary`, `--text-primary`,
 * `--radius-md`, …), so restyling does not require overriding selectors — a user can
 * retheme the app by setting a handful of variables. This file provides that extension
 * point, and the safety around it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SAFETY PROBLEM
 *
 * A stylesheet can brick the interface. `html { display: none }` leaves nothing to click,
 * `* { pointer-events: none }` leaves nothing to click *and* nothing to see on hover, and
 * an unbalanced brace swallows the rest of the file so the user's intent and the result
 * have nothing to do with each other.
 *
 * No static check can catch every way to do that, so this is layered:
 *
 *   1. **Validation warns before saving.** Unbalanced braces and known-bricking rules are
 *      reported with line numbers, and blocked by default (`?force=1` overrides, because
 *      the user may know better).
 *   2. **The escape hatch is outside CSS's reach.** `POST /api/theme/disable` and
 *      `?theme=off` both work with a browser and a keyboard, which is what remains when
 *      the page is invisible. A file-based path is avoidable entirely.
 *   3. **Every save keeps the previous version**, so reverting is one request rather than
 *      a re-edit.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { existsSync, readFileSync, writeFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadStateFile, saveStateFile } from './state-file.js';

/** Hard cap. Past this the browser repaints slow and the file is not a stylesheet anymore. */
export const THEME_MAX_BYTES = 256 * 1024;

/**
 * Strip a leading UTF-8 BOM.
 *
 * This is hygiene, not a security or correctness fix, and it is worth being precise about why
 * it is still here rather than assumed to be load-bearing:
 *
 *   - **Handling the BOM is already implicit elsewhere.** U+FEFF is part of ECMAScript's
 *     WhiteSpace production, so `String.prototype.trim()` removes it. The selector analysis in
 *     this file and the promotion in `userCss.ts` both trim their selectors, which is why a
 *     sheet beginning `\uFEFFhtml` is still recognised as the root.
 *
 *   - **So this exists for hygiene.** Notepad and PowerShell's `Set-Content -Encoding utf8`
 *     write a BOM, and returning it to the editor means the user saves it back and it
 *     accumulates. Writing files without one keeps the round-trip clean.
 *
 * The implicit handling is non-obvious and load-bearing: replacing a `trim()` with a manual
 * slice would silently reopen the hole where `\uFEFFhtml { display: none }` is not seen as the
 * root. That is pinned by a test in both places rather than left to chance.
 */
export function stripBom(css: string): string {
  return css.charCodeAt(0) === 0xfeff ? css.slice(1) : css;
}

export interface CssIssue {
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface CssValidation {
  issues: CssIssue[];
  /** False when at least one `error` is present. Warnings alone do not block. */
  ok: boolean;
  stats: { bytes: number; rules: number; variables: number };
}

export interface ThemeState {
  enabled: boolean;
  updatedAt: string | null;
}

interface ThemeStateFile {
  schema_version: string;
  enabled: boolean;
  updatedAt: string | null;
}

const SCHEMA = 'she-theme/1';

/**
 * Strip comments, keeping every newline so reported line numbers still match the file.
 *
 * Pattern checks run against this: a comment explaining `display: none` must not be
 * mistaken for the rule itself, and a user should not have to avoid words in their notes.
 */
function stripComments(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    if (css[i] === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      // Preserve newlines so line numbers are unaffected.
      out += css.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    // `//` is not a CSS comment, but users write it out of habit; treating it as one
    // would silently delete the rest of the line, so only a whole-line `//` is skipped
    // and it is reported as a warning instead (see the checks below).
    out += css[i];
    i++;
  }
  return out;
}

/**
 * Split CSS into top-level rule blocks, tracking quotes so a `{` inside a string or a
 * `url(...)` does not confuse the depth count.
 *
 * Returns the blocks with the line each one starts on. Newlines are counted incrementally:
 * computing `slice(0, i).split('\n').length` for every rule is quadratic, which is
 * noticeable on a 256 KB file.
 */
function splitRules(code: string): Array<{ selector: string; body: string; line: number }> {
  const rules: Array<{ selector: string; body: string; line: number }> = [];
  let depth = 0;
  let start = 0;
  let startLine = 1;
  let selectorEnd = -1;
  let line = 1;
  let inString: string | null = null;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\n') { line++; continue; }

    if (inString) {
      if (ch === '\\') i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; continue; }
    if (ch === '{') {
      if (depth === 0) {
        selectorEnd = i;
        // The rule's line is the line of its first non-whitespace selector character.
        startLine = line;
      }
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0 && selectorEnd >= 0) {
        rules.push({
          selector: code.slice(start, selectorEnd).trim(),
          body: code.slice(selectorEnd + 1, i),
          line: startLine,
        });
        start = i + 1;
        startLine = line;
        selectorEnd = -1;
      }
      continue;
    }
  }
  return rules;
}

/**
 * Selectors that reach the whole document.
 *
 * A rule hiding one of these hides the app, so it is treated as an error rather than a
 * style choice — there is no layout in which it looks intentional.
 */
const ROOT_SELECTORS = new Set(['html', 'body', '#root', ':root', '*', 'html, body', ':root, body']);

function targetsRoot(selector: string): boolean {
  // A selector list is checked element by element: `html, h1 { ... }` still hides the app.
  return selector
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .some((s) => ROOT_SELECTORS.has(s));
}

/** Declarations that make an element (and its subtree) unreachable. */
const BRICKING_DECLARATIONS: Array<{ pattern: RegExp; what: string }> = [
  { pattern: /display\s*:\s*none/i, what: 'display:none' },
  { pattern: /visibility\s*:\s*hidden/i, what: 'visibility:hidden' },
  { pattern: /content-visibility\s*:\s*hidden/i, what: 'content-visibility:hidden' },
  { pattern: /opacity\s*:\s*0(?!\.\d*[1-9])\s*[;}]?/i, what: 'opacity:0' },
  { pattern: /pointer-events\s*:\s*none/i, what: 'pointer-events:none' },
  { pattern: /height\s*:\s*0(px|)\s*[;}]?/i, what: 'height:0' },
  { pattern: /max-height\s*:\s*0(px|)\s*[;}]?/i, what: 'max-height:0' },
  { pattern: /overflow\s*:\s*hidden/i, what: 'overflow:hidden' },
];

/**
 * Validate a stylesheet.
 *
 * Deliberately permissive: the goal is to stop someone locking themselves out, not to
 * police their design. Only two things are errors — a file that cannot parse, and a rule
 * that hides the application itself.
 */
export function validateCss(input: string): CssValidation {
  const css = stripBom(input);
  const issues: CssIssue[] = [];
  const bytes = Buffer.byteLength(css, 'utf8');

  if (bytes > THEME_MAX_BYTES) {
    issues.push({
      line: 1,
      severity: 'error',
      message: `样式文件过大（${Math.round(bytes / 1024)}KB，上限 ${Math.round(THEME_MAX_BYTES / 1024)}KB）。`
        + '过大的样式表会让每次重绘都变慢。',
    });
    return { issues, ok: false, stats: { bytes, rules: 0, variables: 0 } };
  }

  const code = stripComments(css);

  // ── Brace balance. An unclosed `{` swallows the rest of the file, so the result has
  //    nothing to do with what the user wrote.
  {
    let depth = 0;
    let inString: string | null = null;
    let firstUnclosedLine = 0;
    let line = 1;
    for (let i = 0; i < code.length; i++) {
      const ch = code[i];
      if (ch === '\n') { line++; continue; }
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = ch; continue; }
      if (ch === '{') {
        if (depth === 0) firstUnclosedLine = line;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) firstUnclosedLine = 0;
      }
    }
    if (depth > 0) {
      issues.push({
        line: firstUnclosedLine || 1,
        severity: 'error',
        message: `缺少 ${depth} 个右花括号「}」。未闭合的规则会把后面所有内容都吃掉，`
          + '所以实际效果和你写的可能完全不同。',
      });
    } else if (depth < 0) {
      issues.push({
        line: 1,
        severity: 'error',
        message: `多出 ${-depth} 个右花括号「}」。`,
      });
    }
  }

  /*
   * Remote fetches.
   *
   * A stylesheet can load remote resources, which turns a local styling file into an
   * outbound request — leaking that the app is running, and from which address. The app
   * deliberately makes no outbound requests except to the model endpoint.
   */
  {
    const remoteImport = /@import\s+(?:url\()?\s*["']?(https?:|\/\/)/gi;
    for (const m of code.matchAll(remoteImport)) {
      issues.push({
        line: code.slice(0, m.index).split('\n').length,
        severity: 'error',
        message: '不允许从远程加载样式（@import http…）：这会泄露你这台机器在运行本应用。'
          + '把样式内容直接粘进来即可。',
      });
    }
    const remoteUrl = /url\(\s*["']?(https?:|\/\/)/gi;
    for (const m of code.matchAll(remoteUrl)) {
      issues.push({
        line: code.slice(0, m.index).split('\n').length,
        severity: 'warning',
        message: '这会向外部地址发起请求。本地图片请用 data: 或 file:// 路径。',
      });
    }
    const legacy = /\b(expression\s*\(|javascript\s*:|behavior\s*:)/gi;
    for (const m of code.matchAll(legacy)) {
      issues.push({
        line: code.slice(0, m.index).split('\n').length,
        severity: 'error',
        message: '不支持 expression() / javascript: / behavior: 这类声明。',
      });
    }
  }

  // ── Rules that hide the application. ──
  const rules = splitRules(code);
  let variables = 0;
  for (const rule of rules) {
    const isRoot = targetsRoot(rule.selector);
    if (isRoot) {
      for (const decl of BRICKING_DECLARATIONS) {
        if (decl.pattern.test(rule.body)) {
          // `height:0`/`overflow:hidden` on html are common and usually harmless; only
          // the ones that make the app unreachable are errors.
          const fatal = ['display:none', 'visibility:hidden', 'content-visibility:hidden', 'pointer-events:none', 'opacity:0']
            .includes(decl.what);
          issues.push({
            line: rule.line,
            severity: fatal ? 'error' : 'warning',
            message: fatal
              ? `「${rule.selector}」上使用 ${decl.what} 会让界面完全无法操作（连关闭按钮都点不到）。`
              : `「${rule.selector}」上使用 ${decl.what} 可能让内容显示不出来，请确认是有意的。`,
          });
        }
      }
    }
    // A custom property set outside `:root` still works; counting them just tells the
    // user how much they are overriding.
    for (const m of rule.body.matchAll(/--[\w-]+\s*:/g)) { void m; variables++; }
  }

  return {
    issues,
    ok: !issues.some((i) => i.severity === 'error'),
    stats: { bytes, rules: rules.length, variables },
  };
}

/**
 * Where the user's stylesheet and its state live.
 *
 * In the app directory (`~/.she-app/`), NOT in the workspace — alongside the wallpaper and
 * the plugins.
 *
 * This is a personal display preference, and workspace-local storage produced a real bug for
 * the wallpaper: switching workspace silently changed the background, because the setting
 * was stored next to the sessions. A stylesheet stored the same way would silently restyle
 * the app on every workspace switch, which is worse — the user would think they had broken
 * something.
 *
 * It also has to be reachable by hand. "Use your own stylesheet" means the file has to be
 * findable in a file manager, and a fixed path in the app directory is.
 */
export function themePaths(appDir: string): { css: string; prev: string; state: string } {
  return {
    css: join(appDir, 'theme.css'),
    prev: join(appDir, 'theme.css.prev'),
    state: join(appDir, 'theme-state.json'),
  };
}

export function loadTheme(appDir: string): { enabled: boolean; css: string; updatedAt: string | null; path: string } {
  const paths = themePaths(appDir);
  const state = loadStateFile<ThemeStateFile>({
    path: paths.state,
    version: SCHEMA,
    empty: () => ({ schema_version: SCHEMA, enabled: true, updatedAt: null }),
    parse: (raw) => {
      const r = raw as ThemeStateFile;
      if (typeof r.enabled !== 'boolean') throw new Error('enabled 不是布尔值');
      return {
        schema_version: SCHEMA,
        enabled: r.enabled,
        updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : null,
      };
    },
    migrations: { '*': (raw) => ({ ...raw, schema_version: SCHEMA }) },
  });

  let css = '';
  try {
    // Read without the BOM so the editor does not hand it back to the user to save again.
    // (Recognising selectors does not depend on this — `trim()` treats U+FEFF as whitespace.)
    if (existsSync(paths.css)) css = stripBom(readFileSync(paths.css, 'utf8'));
  } catch {
    // An unreadable stylesheet must not stop the app from starting.
    css = '';
  }

  return { enabled: state.data.enabled, css, updatedAt: state.data.updatedAt, path: paths.css };
}

/**
 * A stylesheet write failure, described in a way the user can act on.
 *
 * Node's own message ("EACCES: permission denied, open 'C:\Users\…\theme.css'") is accurate but
 * wrapped in an errno prefix, and the generic error handler reduced anything thrown here to
 * `{"error":"Internal Server Error"}` — which says nothing about which file is involved or that
 * the problem is permissions rather than syntax. Everywhere else in this feature an error names
 * the line and the reason, so this would have been the one place the user is left guessing.
 *
 * A read-only file is the likeliest cause in practice: `theme.css` sits in the app directory
 * beside the user's other config, where it may have been marked read-only, checked into a
 * repository with restrictive modes, or created by a tool running as another user.
 */
function describeWriteFailure(path: string, err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return `${path} 无法写入（权限不足）。这个文件如果是只读的，取消只读后再保存。`;
    case 'EISDIR':
      return `${path} 是一个目录，不是文件。删掉这个目录后重试。`;
    case 'ENOSPC':
      return `磁盘空间不足，无法写入 ${path}。`;
    case 'EBUSY':
    case 'ETXTBSY':
      return `${path} 正被其他程序占用，稍后重试。`;
    case 'EROFS':
      return `${path} 位于只读文件系统，无法写入。`;
    default:
      return `${path} 写入失败：${(err as Error)?.message ?? String(err)}`;
  }
}

/**
 * Copy the current stylesheet aside as the previous version.
 *
 * Read the contents and write them out, rather than `copyFileSync`.
 *
 * On Windows `copyFileSync` carries the source's attributes with it, so if the user had marked
 * `theme.css` read-only the backup inherited that flag — and "restore the previous version",
 * the action a user reaches for precisely when something is wrong, then failed with a bare
 * `EPERM: operation not permitted`. Writing fresh bytes sidesteps the attribute entirely.
 *
 * Best-effort by design: losing the undo copy is far better than refusing to save because a
 * backup could not be written.
 */
function snapshotForRevert(paths: { css: string; prev: string }): void {
  try {
    if (!existsSync(paths.css)) return;
    writeFileSync(paths.prev, readFileSync(paths.css), 'utf8');
  } catch { /* the backup is best-effort */ }
}

export function saveTheme(appDir: string, css: string, opts?: { enabled?: boolean }): ThemeState & { validation: CssValidation } {
  const paths = themePaths(appDir);

  // Reverting is the most likely next action after a stylesheet goes wrong, and going through
  // the API means it still works when the current stylesheet has hidden the UI.
  snapshotForRevert(paths);

  // The directory is created at boot, but a save must not depend on that having happened —
  // the stylesheet is also writable before the server ever started.
  mkdirSync(dirname(paths.css), { recursive: true });
  try {
    // Write without a BOM, so the file never accumulates one even if one arrived through the API.
    writeFileSync(paths.css, stripBom(css), 'utf8');
  } catch (err) {
    // Report a described failure rather than letting the generic handler reduce it to
    // "Internal Server Error": a save that fails must say why, or the user cannot fix it.
    throw new Error(describeWriteFailure(paths.css, err));
  }

  const current = loadTheme(appDir);
  const enabled = opts?.enabled ?? current.enabled;
  const updatedAt = new Date().toISOString();
  saveStateFile(paths.state, { schema_version: SCHEMA, enabled, updatedAt });

  return { enabled, updatedAt, validation: validateCss(css) };
}

/** Turn the user stylesheet off without deleting it. */
export function setThemeEnabled(appDir: string, enabled: boolean): ThemeState {
  const paths = themePaths(appDir);
  const updatedAt = new Date().toISOString();
  saveStateFile(paths.state, { schema_version: SCHEMA, enabled, updatedAt });
  return { enabled, updatedAt };
}

/** Restore the version from before the last save. */
export function revertTheme(appDir: string): { ok: boolean; css?: string; reason?: string } {
  const paths = themePaths(appDir);
  if (!existsSync(paths.prev)) {
    return { ok: false, reason: '没有上一版可以恢复（还没有保存过）。' };
  }
  try {
    const previous = readFileSync(paths.prev, 'utf8');
    // Swap, so the revert is itself undoable.
    const currentCss = existsSync(paths.css) ? readFileSync(paths.css, 'utf8') : '';
    writeFileSync(paths.css, previous, 'utf8');
    writeFileSync(paths.prev, currentCss, 'utf8');
    return { ok: true, css: previous };
  } catch (err) {
    // Name the file and the reason. A revert is an act of recovery, so failing with a bare
    // errno is the least helpful moment to do it.
    return { ok: false, reason: describeWriteFailure(paths.css, err) };
  }
}

/** Delete the user stylesheet entirely. */
export function clearTheme(appDir: string): void {
  const paths = themePaths(appDir);
  // Keep a copy before deleting, so a mistaken delete is recoverable.
  snapshotForRevert(paths);
  rmSync(paths.css, { force: true });
  saveStateFile(paths.state, { schema_version: SCHEMA, enabled: true, updatedAt: new Date().toISOString() });
}

/** Size on disk, for reporting. */
export function themeBytes(appDir: string): number {
  const paths = themePaths(appDir);
  try {
    return existsSync(paths.css) ? statSync(paths.css).size : 0;
  } catch {
    return 0;
  }
}
