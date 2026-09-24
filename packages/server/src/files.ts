import { readdirSync, statSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep, normalize, extname, dirname, basename, isAbsolute } from 'node:path';
import { platform } from 'node:os';

const IS_WINDOWS = platform() === 'win32';
const SKIP = new Set(['node_modules', '.git', 'dist', '.she', '.next', 'coverage']);

export interface FsNode {
  name: string;
  path: string; // relative to workspace
  type: 'file' | 'dir';
  size?: number;
  children?: FsNode[];
}

/**
 * Confine a requested path to `root`, following symlinks.
 *
 * Exported so every subsystem that touches user-supplied paths shares one
 * implementation (fs routes, plugin file access, KB import). A second copy of
 * this logic is how a jail quietly develops a hole in one place only.
 */
export function jailPath(root: string, requested: string): string {
  const abs = resolve(root, requested || '.');
  let rel = relative(root, abs);
  if (IS_WINDOWS) rel = rel.replace(/\//g, '\\');
  if (rel.startsWith('..') || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }
  const nr = normalize(root);
  const na = normalize(abs);
  const cr = IS_WINDOWS ? nr.toLowerCase() : nr;
  const ca = IS_WINDOWS ? na.toLowerCase() : na;
  if (ca !== cr && !ca.startsWith(cr.endsWith(sep) ? cr : cr + sep)) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }

  // The checks above are purely textual, so a symlink placed INSIDE the
  // workspace but pointing outside it would pass. Resolve the real target and
  // re-check before handing the path back.
  const contains = (base: string, cand: string): boolean => {
    const b = IS_WINDOWS ? base.toLowerCase() : base;
    const c = IS_WINDOWS ? cand.toLowerCase() : cand;
    if (b === c) return true;
    const r = relative(b, c);
    return Boolean(r) && !r.startsWith('..') && !isAbsolute(r);
  };

  let realRoot = nr;
  try { realRoot = realpathSync.native(nr); } catch { /* keep */ }

  let realAbs = na;
  try {
    realAbs = realpathSync.native(na);
  } catch {
    // Not created yet: resolve the existing parent instead.
    try {
      realAbs = join(realpathSync.native(dirname(na)), basename(na));
    } catch { /* keep */ }
  }

  if (!contains(realRoot, realAbs)) {
    throw new Error(`Path escapes workspace via link: ${requested}`);
  }
  return abs;
}

export function listTree(workspaceRoot: string, relPath = '.', depth = 2): FsNode[] {
  const abs = jailPath(workspaceRoot, relPath);
  if (!existsSync(abs)) return [];
  const st = statSync(abs);
  if (!st.isDirectory()) {
    return [{ name: abs.split(/[/\\]/).pop()!, path: relative(workspaceRoot, abs).replace(/\\/g, '/'), type: 'file', size: st.size }];
  }

  function walk(dir: string, d: number): FsNode[] {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: FsNode[] = [];
    for (const ent of entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })) {
      if (SKIP.has(ent.name) || ent.name.startsWith('.')) continue;
      const full = join(dir, ent.name);
      const rel = relative(workspaceRoot, full).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        const node: FsNode = { name: ent.name, path: rel, type: 'dir' };
        if (d > 0) node.children = walk(full, d - 1);
        nodes.push(node);
      } else if (ent.isFile()) {
        let size = 0;
        try { size = statSync(full).size; } catch { /* ignore */ }
        nodes.push({ name: ent.name, path: rel, type: 'file', size });
      }
    }
    return nodes;
  }

  return walk(abs, depth);
}

export function readWorkspaceFile(workspaceRoot: string, relPath: string, maxBytes = 0): { path: string; content: string; truncated: boolean } {
  const abs = jailPath(workspaceRoot, relPath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error(`Not a file: ${relPath}`);
  }
  const buf = readFileSync(abs);
  // maxBytes <= 0 means the whole file. A positive value is only for a caller
  // that asked for a slice.
  const truncated = maxBytes > 0 && buf.byteLength > maxBytes;
  const slice = truncated ? buf.subarray(0, maxBytes) : buf;
  // skip obvious binaries
  const ext = extname(abs).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.exe', '.dll', '.zip'].includes(ext)) {
    throw new Error(`Binary file not previewable: ${relPath}`);
  }
  return {
    path: relative(workspaceRoot, abs).replace(/\\/g, '/'),
    content: slice.toString('utf8'),
    truncated,
  };
}

export interface SuggestHit {
  path: string;
  type: 'file' | 'dir';
  name: string;
}

/** Path/name prefix-substring suggest — NOT content search / not RAG. */
export function suggestPaths(workspaceRoot: string, query: string, limit = 20): SuggestHit[] {
  const q = (query || '').trim().toLowerCase().replace(/\\/g, '/');
  const hits: SuggestHit[] = [];
  const root = jailPath(workspaceRoot, '.');

  function walk(dir: string) {
    if (hits.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (hits.length >= limit) return;
      if (SKIP.has(ent.name) || ent.name.startsWith('.')) continue;
      const full = join(dir, ent.name);
      const rel = relative(workspaceRoot, full).replace(/\\/g, '/');
      const name = ent.name;
      const hay = (rel + ' ' + name).toLowerCase();
      const match = !q || hay.includes(q) || name.toLowerCase().startsWith(q);
      if (ent.isDirectory()) {
        if (match) hits.push({ path: rel, type: 'dir', name });
        walk(full);
      } else if (ent.isFile() && match) {
        hits.push({ path: rel, type: 'file', name });
      }
    }
  }

  walk(root);
  // Prefer shorter / deeper-relevant paths first
  hits.sort((a, b) => {
    const as = a.path.toLowerCase().startsWith(q) || a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const bs = b.path.toLowerCase().startsWith(q) || b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (as !== bs) return as - bs;
    return a.path.length - b.path.length;
  });
  return hits.slice(0, limit);
}