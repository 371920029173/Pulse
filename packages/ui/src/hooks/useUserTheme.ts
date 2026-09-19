/**
 * User stylesheet, applied to the document.
 *
 * Injected as a single `<style>` element appended to `<head>` LAST, so it wins the
 * cascade without `!important` — the user should not have to fight specificity to change
 * a colour.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GETTING OUT OF A BAD STYLESHEET
 *
 * A stylesheet can hide the interface, and no amount of validation can prevent every way
 * of doing that. So there are two ways out that do not need the interface to work:
 *
 *   `?theme=off` in the URL   — typing an address is possible with no visible UI
 *   `POST /api/theme/disable` — reachable with curl, or as a bookmarklet
 *
 * `?theme=off` persists the change, because a one-off disable that comes back on the next
 * reload is not an escape.
 *
 * The URL is cleaned afterwards with `replaceState`, so a user who fixes their stylesheet
 * is not left with a stale parameter that keeps disabling it.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { promoteDocumentSelectors } from '../lib/userCss';
import { t } from '../lib/i18n';

export interface CssIssue {
  line: number;
  severity: 'error' | 'warning';
  message: string;
}

export interface ThemeSnapshot {
  enabled: boolean;
  css: string;
  path: string | null;
  bytes: number;
  maxBytes: number;
  updatedAt: string | null;
  issues: CssIssue[];
  stats: { bytes: number; rules: number; variables: number };
}

const EMPTY: ThemeSnapshot = {
  enabled: true,
  css: '',
  path: null,
  bytes: 0,
  maxBytes: 0,
  updatedAt: null,
  issues: [],
  stats: { bytes: 0, rules: 0, variables: 0 },
};

const STYLE_ID = 'she-user-theme';

/** Create or update the injected element. */
function applyCss(css: string): { applied: boolean; reason?: string } {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    el.setAttribute('data-surface', 'user-theme');
    // Appended last so it overrides the app's own rules without specificity games.
    document.head.appendChild(el);
  }

  /*
   * Promote the document-level selectors before injecting.
   *
   * Without this, `:root { --accent: X }` loses to the app's `[data-theme="light"]` block,
   * which has higher specificity — so the variable would apply in dark mode and silently not
   * in light. See `lib/userCss.ts`. The file on disk is untouched.
   *
   * The BOM is dropped as hygiene; the promotion is tolerant of one anyway, because `trim()`
   * treats U+FEFF as whitespace.
   */
  el.textContent = css.trim() ? promoteDocumentSelectors(css.replace(/^\uFEFF/, '')) : '';
  if (!css.trim()) return { applied: true };

  /*
   * Verify it actually parsed.
   *
   * Browsers drop invalid CSS silently, and a file that produces ZERO rules is almost
   * always a syntax error rather than a deliberate empty stylesheet. Reporting it means
   * the user sees "your stylesheet did not apply" instead of wondering why nothing
   * changed.
   */
  try {
    const rules = (el.sheet as CSSStyleSheet | null)?.cssRules?.length ?? 0;
    if (rules === 0) {
      return { applied: false, reason: t('样式没有解析出任何规则，可能语法有误。') };
    }
  } catch {
    // Cross-origin or a not-yet-attached sheet: not worth failing the injection over.
  }
  return { applied: true };
}

function removeCss(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/** Read and consume `?theme=off`, if present. */
async function escapeHatchFromUrl(): Promise<boolean> {
  const url = new URL(window.location.href);
  if (url.searchParams.get('theme') !== 'off') return false;
  try {
    await fetch('/api/theme/disable', { method: 'POST' });
  } catch {
    // Even if the request fails, stop applying the stylesheet for this load — otherwise
    // the escape does nothing at all, which is worse than not persisting it.
    removeCss();
  }
  url.searchParams.delete('theme');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
  return true;
}

/** The shape `useUserTheme` returns, so a panel can take it as a prop. */
export type UserThemeApi = ReturnType<typeof useUserTheme>;

export function useUserTheme() {  const [theme, setTheme] = useState<ThemeSnapshot>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Set when the injected CSS produced no rules, so the UI can say so. */
  const [applyWarning, setApplyWarning] = useState<string | null>(null);
  const loaded = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/theme');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as Omit<ThemeSnapshot, 'issues'> & { validation?: { issues: CssIssue[] } };
      const snap: ThemeSnapshot = {
        ...EMPTY,
        ...data,
        issues: data.validation?.issues ?? [],
      };
      setTheme(snap);
      setError(null);
      loaded.current = true;
      return snap;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Escape first, then load: the order matters, because loading would otherwise apply the
  // stylesheet the user is trying to escape for one frame.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const escaped = await escapeHatchFromUrl();
      const snap = await refresh();
      if (cancelled) return;
      if (escaped) {
        setApplyWarning(t('已停用自定义样式（?theme=off）。样式文件仍然保留。'));
        removeCss();
        return;
      }
      if (snap?.enabled) {
        const r = applyCss(snap.css);
        setApplyWarning(r.applied ? null : (r.reason ?? null));
      } else {
        removeCss();
      }
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  /** Re-apply whenever the snapshot changes. */
  useEffect(() => {
    if (!loaded.current) return;
    if (theme.enabled) {
      const r = applyCss(theme.css);
      setApplyWarning(r.applied ? null : (r.reason ?? null));
    } else {
      removeCss();
    }
  }, [theme]);

  /**
   * Save, returning the issues so a form can show them. Errors do not throw.
   *
   * `error` carries the server's explanation when the save failed for a reason that is not a
   * validation issue — an unwritable file, a directory in the way. Without it the caller can
   * only see `ok: false` with no issues and has to guess; the editor used to guess "fix the
   * errors first", which is actively misleading when the real cause is a read-only file and
   * there is nothing to fix.
   */
  const save = useCallback(async (
    css: string,
    opts?: { force?: boolean; enabled?: boolean },
  ): Promise<{ ok: boolean; issues: CssIssue[]; forced?: boolean; error?: string }> => {
    const q = opts?.force ? '?force=1' : '';
    const r = await fetch(`/api/theme${q}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ css, ...(opts?.enabled !== undefined ? { enabled: opts.enabled } : {}) }),
    });
    let body: { ok?: boolean; issues?: CssIssue[]; forced?: boolean; hint?: string; error?: string } = {};
    try { body = await r.json(); } catch { /* a body is not guaranteed on failure */ }
    await refresh();
    // Fall back to the status code when the body carries no message, so a failure is never
    // reported as silence.
    const error = body.error ?? (r.ok ? undefined : `HTTP ${r.status}`);
    return { ok: Boolean(body.ok), issues: body.issues ?? [], forced: body.forced, error };
  }, [refresh]);

  /** Validate a draft without saving. Debounced by the caller. */
  const validate = useCallback(async (css: string): Promise<{ issues: CssIssue[]; stats: ThemeSnapshot['stats'] } | null> => {
    try {
      const r = await fetch('/api/theme/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ css }),
      });
      if (!r.ok) return null;
      const body = (await r.json()) as { issues?: CssIssue[]; stats?: ThemeSnapshot['stats'] };
      return { issues: body.issues ?? [], stats: body.stats ?? EMPTY.stats };
    } catch {
      // A failed check must not look like "no problems".
      return null;
    }
  }, []);

  const disable = useCallback(async () => {
    await fetch('/api/theme/disable', { method: 'POST' });
    await refresh();
  }, [refresh]);

  const enable = useCallback(async () => {
    await fetch('/api/theme/enable', { method: 'POST' });
    await refresh();
  }, [refresh]);

  const reset = useCallback(async () => {
    await fetch('/api/theme', { method: 'DELETE' });
    await refresh();
  }, [refresh]);

  const revert = useCallback(async (): Promise<{ ok: boolean; reason?: string }> => {
    const r = await fetch('/api/theme/revert', { method: 'POST' });
    let body: { ok?: boolean; css?: string } = {};
    try { body = await r.json(); } catch { /* ignore */ }
    await refresh();
    if (!r.ok) return { ok: false, reason: t('没有上一版可以恢复') };
    if (body.css !== undefined && body.css !== null) return { ok: true };
    return { ok: Boolean(body.ok) };
  }, [refresh]);

  return { theme, loading, error, applyWarning, save, disable, enable, reset, revert, refresh, validate };
}
