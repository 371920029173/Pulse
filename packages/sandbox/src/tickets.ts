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

/** 隔离记录：什么时候、因为什么、把文件挪到了哪儿。 */
export interface TicketRecoveryInfo {
  /** 隔离副本的完整路径（与原文件同目录，名字带 `.corrupt-<时间戳>`）。 */
  backup: string;
  /** 读不懂的原因（JSON 解析报错原文 / 根不是数组）。 */
  reason: string;
  /** 隔离发生的时间（ISO）。 */
  at: string;
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
  private lastRecovery: TicketRecoveryInfo | null = null;

  constructor(workspaceRoot: string) {
    const dir = path.join(workspaceRoot, '.she');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'confirm-tickets.json');
  }

  /**
   * 最近一次 load 把文件隔离掉时返回原因，否则 null。
   *
   * 必须有一个能问到的信号：一个坏掉又被挪走的票据文件，与"这个工作区从没有过票据"
   * 在磁盘上看起来一模一样（原路径空空如也），不报出来就是静默的数据丢失 ——
   * 用户只会发现"我刚点过确认，怎么又让我确认一遍"。
   */
  recoveryInfo(): TicketRecoveryInfo | null {
    return this.lastRecovery;
  }

  /**
   * 把读不懂的文件挪到一边，绝不覆盖。
   *
   * AGENTS.md「Known traps · State files must never be silently replaced」：读不懂的文件要
   * **移走**，永远不要覆盖 —— 早先的构建把任何解析失败当成"没有数据"，然后把这份空数据
   * 写回用户文件，对话/计划/票据就这么没了。这里同理：旧 load() 是
   * `catch { return new Map() }`，紧接着 issue()/consume() 的 save() 会用空表覆盖原文件，
   * 一个坏字节就抹掉所有尚未过期的票据（=用户得把刚批准过的命令再批准一遍，或者反过来，
   * 一次误操作把本可以核对的证据直接销毁）。
   *
   * 与 `checkpoints.ts` 的 `quarantine()` 保持同一套手法（同包，勿另创一套）：
   * rename 优先（原子、不复制字节），rename 失败（Windows 上文件被暂时锁住、
   * 或跨设备）退化为 copy + rm；两者都失败就只当作没隔离成 —— 调用方仍拿到空表，
   * 但会带着 lastRecovery 之外的"无信号"状态，绝不假装成功过。
   */
  private quarantine(reason: string): void {
    if (!fs.existsSync(this.filePath)) return;
    /*
     * 名字必须唯一。只用时间戳会在同一毫秒内两次恢复时撞名，第二次 rename 就压在
     * 第一份备份上 —— 把这份隔离本该保护的数据又毁一次。
     */
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let backup = `${this.filePath}.corrupt-${stamp}`;
    for (let n = 1; fs.existsSync(backup); n++) backup = `${this.filePath}.corrupt-${stamp}-${n}`;
    try {
      fs.renameSync(this.filePath, backup);
    } catch {
      // 最后手段：复制能保住字节，即使原文件留在原地。
      try {
        fs.copyFileSync(this.filePath, backup);
        fs.rmSync(this.filePath, { force: true });
      } catch {
        return;
      }
    }
    this.lastRecovery = { backup, reason, at: new Date().toISOString() };
    // 打到 stderr 而不是只存字段：票是"当下就要用"的状态，隔离发生时前端/终端能立刻看见。
    // eslint-disable-next-line no-console
    console.error(`[confirm-tickets] unreadable file quarantined: ${reason} → ${backup}`);
  }

  private load(): Map<string, ConfirmTicket> {
    this.lastRecovery = null;
    if (!fs.existsSync(this.filePath)) return new Map();
    let text: string;
    try {
      text = fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '');
    } catch (err) {
      this.quarantine(`read failed: ${(err as Error).message}`);
      return new Map();
    }
    /*
     * 0 字节的文件不是损坏：那是"写到一半断电"留下的空壳，隔离它只会每天攒一个垃圾副本。
     * 真正的损坏是"有内容但读不懂"，那种才可能是用户数据的残余。
     */
    if (!text.trim()) return new Map();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.quarantine(`invalid JSON: ${(err as Error).message}`);
      return new Map();
    }
    if (!Array.isArray(parsed)) {
      // `JSON.parse('null')` 与 `{}` 都能解析成功，但都不是票据表 —— 同样不能当"空表"覆盖。
      this.quarantine('root is not an array');
      return new Map();
    }
    const map = new Map<string, ConfirmTicket>();
    for (const entry of parsed) {
      const t = entry as ConfirmTicket | null;
      if (t && typeof t === 'object' && typeof t.ticket_id === 'string') map.set(t.ticket_id, t);
    }
    return map;
  }

  /**
   * tmp + rename 的原子写：与 `state-file.ts:saveStateFile` 同一套。
   *
   * 直写 `writeFileSync(this.filePath, …)` 意味着"写到一半断电 = 半截 JSON"，而半截 JSON
   * 正是上面 load() 要隔离的那种文件 —— 也就是说旧写法自己在制造它要防的事故。
   * 三个细节都要留着：
   *   - tmp 名按"每次调用"唯一（pid + 序号 + 时间），两个 store 指向同一路径时不会互相
   *     把对方写了一半的字节 rename 到位；
   *   - **先 fsync 再 rename**。NTFS 只保证元数据顺序：rename 立即让新名字可见，而字节还
   *     可能在写缓存里。2026-10-11 就是这样丢过一份 21MB 的 sessions.json —— 文件在、大小对、
   *     内容后 43% 是 NUL。没有 fsync，原子性只是关于"名字"的承诺。
   *   - 失败时删掉自己的 tmp 并抛出：目标文件仍是上一份好数据，旁边也不留下一个看起来
   *     像状态文件的 .tmp。
   */
  private save(map: Map<string, ConfirmTicket>): void {
    const arr = [...map.values()].filter((t) => Date.now() <= Date.parse(t.expires_at));
    const text = JSON.stringify(arr, null, 2);
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      const fd = fs.openSync(tmp, 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* tmp 删不掉不影响结论：目标文件仍是上一份好数据 */
      }
      throw err;
    }
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
