/**
 * UI localization.
 *
 * Design choice worth stating: the DICTIONARY KEY IS THE CHINESE SOURCE TEXT.
 *
 *   t('定时任务')            // -> 'Scheduled tasks' in English, '定时任务' in Chinese
 *   t('已删除 {n} 个任务', { n: 3 })
 *
 * The alternative — inventing symbolic keys like `schedule.title` — needs a naming
 * convention, a key for every string, and it fails badly when incomplete: a
 * missing entry renders a raw key to the user (`schedule.title` on screen). This
 * project has ~660 user-facing Chinese strings; converting them all at once would
 * mean touching all 28 components in one pass, which is how UIs break.
 *
 * Keying on the source text means:
 *   - a missing translation degrades to Chinese, which is readable, not a raw key
 *   - conversion can proceed file by file without a half-translated UI
 *   - a translator can be handed the file and work without the codebase
 *
 * The cost is that editing the Chinese wording invalidates its translation. That
 * is an acceptable trade for a project whose source language is Chinese, and the
 * `i18n-check` script reports coverage so drift is visible rather than silent.
 */

export type Locale = 'zh' | 'en';

export const LOCALES: Array<{ id: Locale; label: string }> = [
  { id: 'zh', label: '中文' },
  { id: 'en', label: 'English' },
];

const STORAGE_KEY = 'she.locale';

/** Values substituted into `{name}` placeholders. */
export type Vars = Record<string, string | number>;

type Dictionary = Record<string, string>;

let current: Locale = 'zh';
const dictionaries: Record<Locale, Dictionary> = { zh: {}, en: {} };

/** Registered so `t()` can use it without importing the component tree. */
export function registerDictionary(locale: Locale, dict: Dictionary): void {
  dictionaries[locale] = dict;
}

/** The active locale. */
export function getLocale(): Locale {
  return current;
}

/** Switch locale and remember it. */
export function setLocale(locale: Locale): void {
  current = locale;
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
    // Lets CSS react (font stack, line-height) without prop-drilling.
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  } catch {
    // Storage can be unavailable (private mode); the in-memory value still works.
  }
}

/** Restore the stored locale, if any. Defaults to Chinese (the source language). */
export function initLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh' || stored === 'en') {
      current = stored;
    } else {
      // Fall back to the browser's preference so an English user gets English
      // without hunting for the setting. Chinese stays the default otherwise.
      current = (navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }
  } catch {
    current = 'zh';
  }
  document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
  return current;
}

/**
 * Translate a string.
 *
 * Falls back to the source text, then to substituting placeholders in it, so an
 * untranslated string is still usable rather than blank or a raw key.
 */
export function t(source: string, vars?: Vars): string {
  const dict = dictionaries[current];
  const hit = dict[source];
  let out = hit ?? source;
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      out = out.split(`{${key}}`).join(String(value));
    }
  }
  return out;
}

/**
 * Pick between two phrasings by count.
 *
 * Chinese does not inflect for number, so this is mostly for English; the source
 * text is the singular form and the plural is looked up under `"<source>|plural"`.
 */
export function tn(count: number, source: string, vars?: Vars): string {
  const key = count === 1 ? source : `${source}|plural`;
  return t(key, { ...vars, count });
}

/** How much of the source text has a translation, for the coverage check. */
export function translationCoverage(sources: string[], locale: Locale): { covered: number; total: number } {
  const dict = dictionaries[locale];
  let covered = 0;
  for (const s of sources) {
    if (dict[s]) covered++;
  }
  return { covered, total: sources.length };
}
