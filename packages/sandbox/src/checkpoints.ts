import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface Checkpoint {
  checkpoint_id: string;
  patch_id: string;
  path: string;
  before: string;
  after: string;
  created_at: string;
}

function isCheckpoint(x: unknown): x is Checkpoint {
  if (!x || typeof x !== 'object') return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.checkpoint_id === 'string' &&
    typeof c.patch_id === 'string' &&
    typeof c.path === 'string' &&
    typeof c.before === 'string' &&
    typeof c.after === 'string' &&
    typeof c.created_at === 'string'
  );
}

/**
 * Last-N applied patches for undo (restores `before` content).
 *
 * Corrupt files are moved aside, never silently overwritten with `[]` — that
 * used to erase the undo history the next time anything saved.
 */
export class CheckpointStore {
  private filePath: string;
  private maxKeep: number;
  private lastRecovery: { backup: string; reason: string } | null = null;

  constructor(workspaceRoot: string, maxKeep = 30) {
    const dir = path.join(workspaceRoot, '.she');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'checkpoints.json');
    this.maxKeep = maxKeep;
  }

  /** Notice from the last load, if the file was quarantined. */
  get recoveryNotice(): { backup: string; reason: string } | null {
    return this.lastRecovery;
  }

  private quarantine(reason: string): void {
    if (!fs.existsSync(this.filePath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${this.filePath}.corrupt-${stamp}`;
    try {
      fs.renameSync(this.filePath, backup);
    } catch {
      try {
        fs.copyFileSync(this.filePath, backup);
        fs.rmSync(this.filePath);
      } catch {
        return;
      }
    }
    this.lastRecovery = { backup, reason };
    // eslint-disable-next-line no-console
    console.error(`[checkpoints] unreadable file quarantined: ${reason} → ${backup}`);
  }

  private load(): Checkpoint[] {
    this.lastRecovery = null;
    if (!fs.existsSync(this.filePath)) return [];
    let rawText: string;
    try {
      rawText = fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '');
    } catch (err) {
      this.quarantine(`read failed: ${(err as Error).message}`);
      return [];
    }
    if (!rawText.trim()) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      this.quarantine(`JSON parse failed: ${(err as Error).message}`);
      return [];
    }
    if (!Array.isArray(parsed)) {
      this.quarantine('root is not an array');
      return [];
    }
    const out: Checkpoint[] = [];
    for (const entry of parsed) {
      if (isCheckpoint(entry)) out.push(entry);
    }
    // If every entry was junk but the file claimed to be a list, keep a backup
    // only when the list was non-empty — empty [] is a valid fresh file.
    if (parsed.length > 0 && out.length === 0) {
      this.quarantine('no valid checkpoint entries');
      return [];
    }
    return out;
  }

  private save(list: Checkpoint[]): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(list.slice(0, this.maxKeep), null, 2);
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, payload, 'utf8');
    try {
      fs.renameSync(tmp, this.filePath);
    } catch {
      // Windows: replace target if rename across busy file fails
      try {
        fs.copyFileSync(tmp, this.filePath);
      } finally {
        try { fs.rmSync(tmp); } catch { /* ignore */ }
      }
    }
  }

  push(input: { patch_id: string; path: string; before: string; after: string }): Checkpoint {
    const cp: Checkpoint = {
      checkpoint_id: randomUUID(),
      patch_id: input.patch_id,
      path: input.path.replace(/\\/g, '/'),
      before: input.before,
      after: input.after,
      created_at: new Date().toISOString(),
    };
    const list = this.load();
    list.unshift(cp);
    this.save(list);
    return cp;
  }

  list(limit = 20): Omit<Checkpoint, 'before' | 'after'>[] {
    return this.load()
      .slice(0, limit)
      .map(({ checkpoint_id, patch_id, path: p, created_at }) => ({
        checkpoint_id,
        patch_id,
        path: p,
        created_at,
      }));
  }

  get(id: string): Checkpoint | null {
    return this.load().find((c) => c.checkpoint_id === id) ?? null;
  }

  /** Pop and return the newest checkpoint (for undo last). */
  takeLatest(): Checkpoint | null {
    const list = this.load();
    const cp = list.shift();
    if (!cp) return null;
    this.save(list);
    return cp;
  }

  take(id: string): Checkpoint | null {
    const list = this.load();
    const idx = list.findIndex((c) => c.checkpoint_id === id);
    if (idx < 0) return null;
    const [cp] = list.splice(idx, 1);
    this.save(list);
    return cp ?? null;
  }
}
