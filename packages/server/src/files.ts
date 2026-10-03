import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { jailWorkspacePath } from '@she/shared';

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
 * Now a thin alias over `@she/shared`'s `resolveWorkspacePath` — the one implementation. It used to
 * be a local copy, and the comment here already said why that was a bad idea:
 *
 *   "Exported so every subsystem that touches user-supplied paths shares one implementation (fs
 *    routes, plugin file access, KB import). A second copy of this logic is how a jail quietly
 *    develops a hole in one place only."
 *
 * The hole did appear — in the fourth copy that nobody counted (`lsp-tools.ts`, whose `resolveInWorkspace`
 * skipped the symlink re-check, so the same fixture was refused by `fs_read` and allowed by
 * `lsp_diagnostics`). Three copies of a jail is not two answers; it is three, and the fourth one
 * drifted. The alias stays because callers and checks refer to it by name.
 */
export function jailPath(root: string, requested: string): string {
  return jailWorkspacePath(root, requested);
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