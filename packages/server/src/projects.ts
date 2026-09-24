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
  const roots = [abs, ...read(file).filter((r) => resolve(r) !== abs)].slice(0, 40);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ roots }, null, 2), 'utf8');
}

/** Known project directories that still exist, current one first. */
export function knownProjectRoots(file: string, current: string, extra: string[] = []): string[] {
  const all = [current, ...extra, ...read(file)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of all) {
    if (!raw) continue;
    const abs = resolve(raw);
    if (seen.has(abs) || !existsSync(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}
