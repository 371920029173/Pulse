import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Directories this process has actually opened.
 *
 * The workspace switcher already remembers a short list inside the current
 * project. That list moves when the project moves, so a cross-project session
 * list cannot trust it alone. This file lives in the app directory and is the
 * stable index.
 */

interface ProjectFile {
  roots: string[];
}

function read(file: string): string[] {
  try {
    if (!existsSync(file)) return [];
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProjectFile>;
    return Array.isArray(j.roots) ? j.roots.filter((r) => typeof r === 'string' && r) : [];
  } catch {
    return [];
  }
}

export function rememberProject(file: string, root: string): void {
  const abs = resolve(root);
  const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const roots = [abs, ...read(file).filter((r) => {
    const o = resolve(r);
    return (process.platform === 'win32' ? o.toLowerCase() : o) !== key;
  })].slice(0, 40);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ roots }, null, 2), 'utf8');
}

/**
 * Drop a directory from the index.
 *
 * Called when an isolated copy is reclaimed: its path is about to stop existing, and an index that
 * keeps pointing at removed directories grows into a list of places the rail has to filter out on
 * every poll — with a 40-entry cap, real projects eventually get pushed out by dead ones. Matched
 * case-insensitively, like `rememberProject`, so `d:\x` cannot survive a `D:\x` removal on Windows.
 */
export function forgetProject(file: string, root: string): void {
  const abs = resolve(root);
  const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
  const roots = read(file);
  const kept = roots.filter((r) => {
    const o = resolve(r);
    return (process.platform === 'win32' ? o.toLowerCase() : o) !== key;
  });
  if (kept.length === roots.length) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ roots: kept }, null, 2), 'utf8');
}

/** Known project directories that still exist, current one first. */export function knownProjectRoots(file: string, current: string, extra: string[] = []): string[] {
  const all = [current, ...extra, ...read(file)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of all) {
    if (!raw) continue;
    const abs = resolve(raw);
    /*
     * Deduped by identity, not by spelling. This machine's index held both `d:\AGI\x` and
     * `D:\AGI\x`; two entries mean two session stores and two group stores over one state file, and
     * the rail then lists the same project twice while the two in-memory copies overwrite each
     * other's writes.
     */
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    if (seen.has(key) || !existsSync(abs)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}
