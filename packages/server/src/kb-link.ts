import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, copyFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const KB_LINK_SCHEMA = 'she.kb-link.v1';
export const KB_LINK_FILE = 'kb-link.json';

export interface KbLinkFile {
  schema: typeof KB_LINK_SCHEMA;
  /** Absolute path to the shared (or overridden) sqlite file. */
  dbPath: string;
  updatedAt?: string;
  note?: string;
}

export function kbLinkPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.she', KB_LINK_FILE);
}

export function readKbLink(workspaceRoot: string): KbLinkFile | null {
  const p = kbLinkPath(workspaceRoot);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<KbLinkFile>;
    if (!raw || typeof raw.dbPath !== 'string' || !raw.dbPath.trim()) return null;
    return {
      schema: KB_LINK_SCHEMA,
      dbPath: resolve(raw.dbPath.trim()),
      updatedAt: raw.updatedAt,
      note: raw.note,
    };
  } catch {
    return null;
  }
}

export function writeKbLink(workspaceRoot: string, dbPath: string, note?: string): KbLinkFile {
  const she = join(workspaceRoot, '.she');
  mkdirSync(she, { recursive: true });
  const doc: KbLinkFile = {
    schema: KB_LINK_SCHEMA,
    dbPath: resolve(dbPath),
    updatedAt: new Date().toISOString(),
    note,
  };
  writeFileSync(kbLinkPath(workspaceRoot), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return doc;
}

export function clearKbLink(workspaceRoot: string): void {
  const p = kbLinkPath(workspaceRoot);
  if (existsSync(p)) unlinkSync(p);
}

/**
 * Resolve which sqlite file a workspace should open.
 *
 * Order: explicit env SHE_KB_PATH ? workspace .she/kb-link.json ? local .she/kb.sqlite
 */
export function resolveWorkspaceKbPath(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env): {
  dbPath: string;
  mode: 'env' | 'shared' | 'local';
  link: KbLinkFile | null;
} {
  const root = resolve(workspaceRoot);
  if (env.SHE_KB_PATH && env.SHE_KB_PATH.trim()) {
    const dbPath = isAbsolute(env.SHE_KB_PATH.trim())
      ? resolve(env.SHE_KB_PATH.trim())
      : resolve(root, env.SHE_KB_PATH.trim());
    return { dbPath, mode: 'env', link: readKbLink(root) };
  }
  const link = readKbLink(root);
  if (link) return { dbPath: link.dbPath, mode: 'shared', link };
  return { dbPath: resolve(root, '.she', 'kb.sqlite'), mode: 'local', link: null };
}

/** Copy a sqlite (+ wal/shm if present) to a new shared location. */
export function copyKbFile(fromPath: string, toPath: string): void {
  const from = resolve(fromPath);
  const to = resolve(toPath);
  if (!existsSync(from)) throw new Error(`???????: ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  for (const suf of ['-wal', '-shm']) {
    if (existsSync(from + suf)) copyFileSync(from + suf, to + suf);
  }
}
