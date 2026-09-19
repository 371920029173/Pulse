import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ConfirmTicket {
  ticket_id: string;
  tool: string;
  summary: string;
  created_at: string;
  expires_at: string;
  /**
   * Fingerprint of the arguments this ticket was approved for.
   *
   * Without it a ticket was only bound to the *tool*, so approving
   * `shell: rm -rf build` left a valid ticket that any other command could
   * consume within the 120s window — the user approved one action and a
   * different one executed. Absent on tickets written by older builds, in
   * which case the check is skipped for backwards compatibility.
   */
  args_hash?: string;
}

/**
 * Stable fingerprint of a tool call's arguments.
 *
 * Control keys (leading underscore: `_confirm_ticket`, `_stage`, ...) are
 * excluded because the agent adds them between the confirm request and the
 * approved re-execution, which would otherwise change the hash.
 */
export function fingerprintArgs(tool: string, args?: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(args ?? {}).sort()) {
    if (k.startsWith('_')) continue;
    clean[k] = (args as Record<string, unknown>)[k];
  }
  return createHash('sha256')
    .update(`${tool}|${JSON.stringify(clean)}`)
    .digest('hex')
    .slice(0, 16);
}

/** File-backed confirm tickets so CLI/UI restarts can continue. */
export class ConfirmTicketStore {
  private filePath: string;

  constructor(workspaceRoot: string) {
    const dir = path.join(workspaceRoot, '.she');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'confirm-tickets.json');
  }

  private load(): Map<string, ConfirmTicket> {
    try {
      const arr = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as ConfirmTicket[];
      return new Map(arr.map((t) => [t.ticket_id, t]));
    } catch {
      return new Map();
    }
  }

  private save(map: Map<string, ConfirmTicket>): void {
    const arr = [...map.values()].filter((t) => Date.now() <= Date.parse(t.expires_at));
    fs.writeFileSync(this.filePath, JSON.stringify(arr, null, 2), 'utf8');
  }

  issue(
    tool: string,
    summary: string,
    opts?: { ttlMs?: number; args?: Record<string, unknown> },
  ): ConfirmTicket {
    const now = Date.now();
    const ttlMs = opts?.ttlMs ?? 120_000;
    const ticket: ConfirmTicket = {
      ticket_id: randomUUID(),
      tool,
      summary,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttlMs).toISOString(),
      ...(opts?.args ? { args_hash: fingerprintArgs(tool, opts.args) } : {}),
    };
    const map = this.load();
    map.set(ticket.ticket_id, ticket);
    this.save(map);
    return ticket;
  }

  /** Returns error string if invalid; null if consumed OK. */
  consume(tool: string, ticketId?: string, args?: Record<string, unknown>): string | null {
    if (!ticketId) return 'missing confirm ticket';
    const map = this.load();
    const t = map.get(ticketId);
    if (!t) return 'unknown confirm ticket';
    if (t.tool !== tool) return 'ticket tool mismatch';
    if (Date.now() > Date.parse(t.expires_at)) {
      map.delete(ticketId);
      this.save(map);
      return 'confirm ticket expired';
    }
    // Approved for specific arguments? Then only those arguments may run.
    if (t.args_hash && args && fingerprintArgs(tool, args) !== t.args_hash) {
      return 'ticket does not match these arguments (what was approved differs from what would run)';
    }
    map.delete(ticketId);
    this.save(map);
    return null;
  }
}
