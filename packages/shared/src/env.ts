import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Canonical `.env` handling.
 *
 * There is exactly ONE env file per install: the one returned by
 * `resolveEnvFile()`. Both reading (startup) and writing (Settings UI / CLI)
 * MUST go through it, otherwise saved settings are shadowed by another file
 * on the next boot.
 *
 * Precedence rules:
 *   - real OS env vars always win over any file
 *   - the canonical file is the only file loaded (no double-load shadowing)
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    out[key] = stripQuotes(trimmed.slice(eq + 1).trim());
  }
  return out;
}

function stripQuotes(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Resolve the canonical env file for a project.
 *
 * `SHE_ENV_FILE` wins when set. Otherwise the project root's `.env` is used;
 * a `.env` next to the current working directory is only used when the project
 * root has none (so running the server from a package subdirectory still finds
 * the install-wide file).
 */
export function resolveEnvFile(projectRoot: string, cwd: string = process.cwd()): string {
  const explicit = process.env.SHE_ENV_FILE;
  if (explicit && explicit.trim()) return resolve(explicit.trim());

  const rootEnv = resolve(projectRoot, '.env');
  if (existsSync(rootEnv)) return rootEnv;

  const cwdEnv = resolve(cwd, '.env');
  if (existsSync(cwdEnv)) return cwdEnv;

  // Neither exists yet — create the project-root one.
  return rootEnv;
}

/** Load a dotenv file into process.env. Real OS env vars are never overwritten. */
export function loadEnvFile(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  let loaded = 0;
  try {
    const parsed = parseEnvFile(readFileSync(filePath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        loaded++;
      }
    }
  } catch {
    /* unreadable file: ignore, config falls back to defaults */
  }
  return loaded;
}

/**
 * Copy keys from `legacyPath` into `targetPath` when the target has no value
 * for them yet. Used to recover settings that older builds wrote next to the
 * process cwd instead of the canonical file.
 *
 * Returns the keys that were recovered.
 */
export function mergeMissingEnvFile(targetPath: string, legacyPath: string): string[] {
  if (!existsSync(legacyPath)) return [];
  let legacy: Record<string, string>;
  try {
    legacy = parseEnvFile(readFileSync(legacyPath, 'utf8'));
  } catch {
    return [];
  }

  const targetText = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : '';
  const target = parseEnvFile(targetText);
  const patch: Record<string, string> = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (!value) continue; // never import blank values over nothing
    if (target[key] === undefined || target[key] === '') patch[key] = value;
  }

  const keys = Object.keys(patch);
  if (keys.length) updateEnvFile(targetPath, patch);
  return keys;
}

/**
 * Read-modify-write a dotenv file, preserving comments, order and unrelated
 * keys. `null` / `undefined` removes the key; `''` writes an empty value.
 * Writes are atomic (tmp + rename) so a crash cannot truncate the file.
 */
export function updateEnvFile(
  filePath: string,
  patch: Record<string, string | null | undefined>,
): void {
  const exists = existsSync(filePath);
  const original = exists ? readFileSync(filePath, 'utf8') : '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.length ? original.split(/\r?\n/) : [];
  const handled = new Set<string>();

  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in patch)) return line;
    handled.add(key);
    const value = patch[key];
    return value === null || value === undefined ? null : `${key}=${value}`;
  });

  const out = next.filter((l): l is string => l !== null);

  // Drop trailing blank lines before appending, then re-add one separator.
  while (out.length && out[out.length - 1].trim() === '') out.pop();

  const additions = Object.entries(patch).filter(
    ([key, value]) => !handled.has(key) && value !== null && value !== undefined,
  );
  if (additions.length) {
    const MARKER = '# --- saved by SHE settings ---';
    const lastNonEmpty = [...out].reverse().find((l) => l.trim() !== '');
    if (lastNonEmpty?.trim() !== MARKER) {
      if (out.length) out.push('');
      out.push(MARKER);
    }
    for (const [key, value] of additions) out.push(`${key}=${value}`);
  }

  mkdirSync(dirname(filePath), { recursive: true });
  const text = out.join(eol).replace(/\s*$/, '') + eol;
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, filePath);
}
