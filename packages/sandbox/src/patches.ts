import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface PendingPatch {
  patch_id: string;
  path: string;
  before: string;
  after: string;
  unified: string;
  created_at: string;
  expires_at: string;
}

function unify(filePath: string, before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
  // simple line-oriented diff (not Myers) — good enough for UI
  const max = Math.max(a.length, b.length);
  let hunk: string[] = [];
  let hunkStart = 1;
  const flush = () => {
    if (!hunk.length) return;
    lines.push(`@@ -${hunkStart},${a.length} +${hunkStart},${b.length} @@`);
    lines.push(...hunk);
    hunk = [];
  };
  // Prefer a compact full-file replace style when large
  if (a.length + b.length > 400) {
    lines.push(`@@ -1,${a.length} +1,${b.length} @@`);
    for (const l of a) lines.push(`-${l}`);
    for (const l of b) lines.push(`+${l}`);
    return lines.join('\n');
  }
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      hunk.push(` ${a[i]}`);
      i++; j++;
      continue;
    }
    if (i < a.length) {
      hunk.push(`-${a[i]}`);
      i++;
    }
    if (j < b.length) {
      hunk.push(`+${b[j]}`);
      j++;
    }
  }
  flush();
  if (lines.length === 2) {
    lines.push(`@@ -1,${a.length} +1,${b.length} @@`);
    for (const l of a) lines.push(`-${l}`);
    for (const l of b) lines.push(`+${l}`);
  }
  return lines.join('\n');
}

export class PendingPatchStore {
  private filePath: string;
  constructor(workspaceRoot: string) {
    const dir = path.join(workspaceRoot, '.she');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'pending-patches.json');
  }

  private load(): Map<string, PendingPatch> {
    try {
      const arr = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as PendingPatch[];
      return new Map(arr.map((p) => [p.patch_id, p]));
    } catch {
      return new Map();
    }
  }

  private save(map: Map<string, PendingPatch>): void {
    fs.writeFileSync(this.filePath, JSON.stringify([...map.values()], null, 2));
  }

  stage(relPath: string, before: string, after: string, ttlMs = 10 * 60_000): PendingPatch {
    const map = this.load();
    const now = Date.now();
    const norm = relPath.replace(/\\/g, '/');
    // One pending patch per path (Composer multi-file stack).
    for (const [id, existing] of map) {
      if (existing.path === norm) map.delete(id);
    }
    const patch: PendingPatch = {
      patch_id: randomUUID(),
      path: norm,
      before,
      after,
      unified: unify(norm, before, after),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlMs).toISOString(),
    };
    map.set(patch.patch_id, patch);
    this.save(map);
    return patch;
  }

  clear(): void {
    this.save(new Map());
  }

  get(patchId: string): PendingPatch | null {
    const map = this.load();
    const p = map.get(patchId);
    if (!p) return null;
    if (Date.now() > Date.parse(p.expires_at)) {
      map.delete(patchId);
      this.save(map);
      return null;
    }
    return p;
  }

  take(patchId: string): PendingPatch | null {
    const map = this.load();
    const p = map.get(patchId);
    if (!p) return null;
    map.delete(patchId);
    this.save(map);
    if (Date.now() > Date.parse(p.expires_at)) return null;
    return p;
  }

  list(): PendingPatch[] {
    return [...this.load().values()];
  }
}
