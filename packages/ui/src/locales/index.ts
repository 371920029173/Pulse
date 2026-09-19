/**
 * Locale registration.
 *
 * Imported once from `main.tsx`. Chinese needs no dictionary — it is the source
 * language, so the key IS the Chinese text and `t()` falls back to it. Only
 * translations are stored, which keeps the fallback path exercised on every
 * untranslated string rather than only in tests.
 */
import { registerDictionary } from '../lib/i18n';

/** Chinese is implicit (the source text), but registered so the two are symmetric. */
registerDictionary('zh', {});

// Importing for the side effect of registration. The dictionary is a few KB and
// lazy-loading it would make locale switching asynchronous for no real gain.
import './en';

export {};
