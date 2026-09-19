import { randomUUID } from 'node:crypto';

export type TaskPhase = 'running' | 'done' | 'error';

export interface TaskCard {
  id: string;
  kind: string;
  label: string;
  phase: TaskPhase;
  detail?: string;
  created_at: string;
  updated_at: string;
}

/** In-memory board for background / subagent progress cards. */
export class TaskBoard {
  private tasks = new Map<string, TaskCard>();
  private listeners = new Set<(t: TaskCard[]) => void>();

  list(): TaskCard[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  upsert(partial: { id?: string; kind: string; label: string; phase: TaskPhase; detail?: string }): TaskCard {
    const id = partial.id || randomUUID().slice(0, 10);
    const prev = this.tasks.get(id);
    const now = new Date().toISOString();
    const card: TaskCard = {
      id,
      kind: partial.kind,
      label: partial.label,
      phase: partial.phase,
      detail: partial.detail ?? prev?.detail,
      created_at: prev?.created_at || now,
      updated_at: now,
    };
    this.tasks.set(id, card);
    // prune old finished beyond 30
    const done = this.list().filter((t) => t.phase !== 'running');
    if (done.length > 30) {
      for (const t of done.slice(30)) this.tasks.delete(t.id);
    }
    this.emit();
    return card;
  }

  dismiss(id: string): boolean {
    const ok = this.tasks.delete(id);
    if (ok) this.emit();
    return ok;
  }

  markStaleRunning(reason?: string): number {
    let n = 0;
    const now = new Date().toISOString();
    for (const [id, t] of this.tasks) {
      if (t.phase === 'running') {
        this.tasks.set(id, {
          ...t,
          phase: 'error',
          detail: reason || '连接中断',
          updated_at: now,
        });
        n++;
      }
    }
    if (n) this.emit();
    return n;
  }

  clearFinished(): number {
    let n = 0;
    for (const [id, t] of this.tasks) {
      if (t.phase !== 'running') {
        this.tasks.delete(id);
        n++;
      }
    }
    if (n) this.emit();
    return n;
  }

  private emit(): void {
    const snap = this.list();
    for (const l of this.listeners) {
      try { l(snap); } catch { /* ignore */ }
    }
  }
}

export const taskBoard = new TaskBoard();
