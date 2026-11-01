/*
 * 任务树：无人值守下的自主执行结构。
 *
 * 与 `plan_*` 的分工（这是设计上的关键，不是"又一个待办清单"）：
 *   · plan  —— 扁平步骤 + 依赖，语义是"按顺序做完"，由自动续跑**推动**下一步；
 *   · tree  —— 可自增的树（子任务 / 同级任务），语义是"目标 + 分支"，**不推**，
 *              只在三种出口汇报：全部完成 / 受阻 / 撞预算。
 *
 * 无人值守的含义（用户原话）：假定木星在没有人的状态，所以模型必须自己决策、自己解决问题；
 * 只有"无法回避又解决不了"时才汇报。为此提供特殊的 Ask：
 *   · 提问后 5 分钟没人答 → 按设置"相信/不相信"处理；
 *   · **不可逆的问题永远不走自动**（哪怕设置是"相信"），一律搁置 —— 无人值守 + 不可逆 + 自动决策
 *     三者同时成立时，错一次就是数据没了。
 *
 * 存储：`.she/tasks/<sessionId>/tree.json`（每 chat 一棵，不跨 chat 同步）。坏文件隔离、写入加锁，
 * 与 plans.json 同一套纪律。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolDefinition } from '@she/shared';
import { sessionStateDir } from './session-state.js';

export type TreeStatus = 'pending' | 'active' | 'blocked' | 'shelved' | 'done' | 'dropped';

export interface TreeQuestion {
  id: string;
  text: string;
  options: string[];
  /** 模型认为最优的选项；自动采纳时采用它。 */
  recommend: string;
  /** 不问是否真的走不下去。为真且到期未答（且策略为不信任）→ 判定树受阻。 */
  blocking: boolean;
  /** 自动采纳是否安全。false = 不可逆，**永不**自动采纳。 */
  reversible: boolean;
  askedAt: string;
  deadlineAt: string;
  answeredAt?: string;
  answer?: string;
  autoAnswered?: boolean;
}

export interface TreeNode {
  id: string;
  parentId: string | null;
  title: string;
  intent?: string;
  kind: 'goal' | 'task' | 'subtask';
  status: TreeStatus;
  dependsOn: string[];
  evidence: string[];
  decisions: Array<{ at: string; choice: string; why: string; auto: boolean }>;
  questions: TreeQuestion[];
  note?: string;
  attempts: number;
  log: Array<{ at: string; from: string; to: string; note?: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface TreeFile {
  v: 1;
  sessionId: string;
  rootId: string | null;
  nodes: TreeNode[];
  createdAt: string;
  updatedAt: string;
  /**
   * 急停标记。
   *
   * 2026-11-01 的教训：自动续跑一旦卡在错的状态上，用户手上没有任何办法叫停，只能重启后端。
   * 这个标记就是那个"刹车"：写进文件后，下一次判断立刻停，不需要重启、不需要重新加载代码。
   */
  aborted?: { at: string; reason: string };

  /** 到达过出口的汇报（只会有一份最终汇报，但保留历史便于排错）。 */
  reports: Array<{ at: string; outcome: 'success' | 'blocked' | 'partial'; summary: string }>;
}

export interface TreeSettings {
  /** 相信模型 → 到期自动采纳推荐值；默认不信任（安全侧）。 */
  trustModel: boolean;
  answerTimeoutMs: number;
  maxMinutes: number;
  maxNodeAttempts: number;
  maxNodes: number;
  backupBeforeAuto: boolean;
}

/**
 * 从环境变量读树设置（设置页写的就是这几个键）。
 *
 * 默认：不信任、5 分钟、120 分钟、单节点 3 次、60 节点。
 * **不可逆问题不走自动**这一条不在设置里 —— 它是硬规则，不给开关。
 */
export function treeSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): TreeSettings {
  const num = (key: string, dflt: number): number => {
    const raw = Number(env[key]);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : dflt;
  };
  const trust = String(env.SHE_TREE_TRUST ?? '').toLowerCase();
  return {
    trustModel: trust === '1' || trust === 'true' || trust === 'yes' || trust === 'on',
    answerTimeoutMs: num('SHE_TREE_TIMEOUT_MIN', 5) * 60_000,
    maxMinutes: num('SHE_TREE_MAX_MINUTES', 120),
    maxNodeAttempts: num('SHE_TREE_MAX_TRIES', 3),
    maxNodes: num('SHE_TREE_MAX_NODES', 60),
    backupBeforeAuto: true,
  };
}

export const DEFAULT_TREE_SETTINGS: TreeSettings = {
  trustModel: false,
  answerTimeoutMs: 5 * 60_000,
  maxMinutes: 120,
  maxNodeAttempts: 3,
  maxNodes: 60,
  backupBeforeAuto: true,
};

const NOW = () => new Date().toISOString();

/** 树文件读不懂就隔离（与 plans/memo 同一纪律：绝不"当空"随后覆盖）。 */
function readTreeFile(file: string, onCorrupt: (backup: string, reason: string) => void): TreeFile | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as TreeFile;
  } catch (err) {
    const backup = `${file}.corrupt-${NOW().replace(/[:.]/g, '-')}`;
    let where = file;
    try {
      renameSync(file, backup);
      where = backup;
    } catch { /* 改不动也不能当空写回去 */ }
    onCorrupt(where, (err as Error)?.message ?? String(err));
    return null;
  }
}

export class TaskTreeStore {
  private settings: TreeSettings;
  private dir: string;
  private file: string;
  private recovery: { backup: string; reason: string } | null = null;
  private data: TreeFile | null = null;

  constructor(private workspaceRoot: string, private sessionId: string, settings?: TreeSettings) {
    this.settings = settings ?? treeSettingsFromEnv();
    this.dir = sessionStateDir(workspaceRoot, sessionId);
    this.file = join(this.dir, 'tree.json');
  }

  recoveryInfo(): { backup: string; reason: string } | null {
    return this.recovery;
  }

  private load(): TreeFile | null {
    // 每次真读盘：同一会话有多个实例（工具侧 / autopilot），内存缓存会让它们各自停在旧快照上。
    const loaded = readTreeFile(this.file, (backup, reason) => { this.recovery = { backup, reason }; });
    this.data = loaded;
    return loaded;
  }

  /** 写入：加锁（跨进程）+ 原子替换，与 plans.json 同一套。 */
  private save(next: TreeFile): void {
    mkdirSync(this.dir, { recursive: true });
    const lock = `${this.file}.lock`;
    let held = false;
    for (let i = 0; i < 20 && !held; i += 1) {
      try {
        const fd = openSync(lock, 'wx');
        writeFileSync(fd, `${process.pid} ${Date.now()}`, 'utf8');
        closeSync(fd);
        held = true;
      } catch {
        let stale = false;
        try {
          const [, at] = readFileSync(lock, 'utf8').trim().split(/\s+/);
          const age = Date.now() - Number(at);
          stale = Number.isFinite(age) && age > 10_000;
        } catch { /* 正在写：按不陈旧处理 */ }
        if (stale) { try { unlinkSync(lock); } catch { /* ignore */ } continue; }
        const until = Date.now() + 100;
        const buf = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(buf, 0, 0, Math.max(0, until - Date.now()));
      }
    }
    if (!held) throw new Error(`任务树文件被占用（${lock}）：稍后重试`);
    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmp, this.file);
      this.data = next;
    } finally {
      try { unlinkSync(lock); } catch { /* ignore */ }
    }
  }

  get(): TreeFile | null {
    return this.load();
  }

  /** 建根（一棵树只有一根）。 */
  create(title: string, intent?: string, subtasks: string[] = []): TreeFile {
    const existing = this.load();
    if (existing?.rootId) throw new Error('这个会话已经有任务树了；要改请在树上加子任务（tree_add），或用 tree_report 收尾');
    const at = NOW();
    const root: TreeNode = {
      id: 'n1', parentId: null, title, intent, kind: 'goal', status: 'active',
      dependsOn: [], evidence: [], decisions: [], questions: [], attempts: 0, log: [], createdAt: at, updatedAt: at,
    };
    const nodes = [root];
    subtasks.forEach((t, i) => {
      nodes.push({
        id: `n${i + 2}`, parentId: root.id, title: t, kind: 'subtask', status: 'pending',
        dependsOn: [], evidence: [], decisions: [], questions: [], attempts: 0, log: [], createdAt: at, updatedAt: at,
      });
    });
    const file: TreeFile = { v: 1, sessionId: this.sessionId, rootId: root.id, nodes, createdAt: at, updatedAt: at, reports: [] };
    this.save(file);
    return file;
  }

  /**
   * 在**调用方手里那份** file 里找节点。
   *
   * 不要再在这里 load()：那是另一份对象图。`ask`/`update`/`answer` 都先 load 一次，改的是那份；
   * 这里再 load 一次会返回新对象，改完 save 的却是原来那份 —— 改动静默丢失。缓存还在时它"碰巧"能用，
   * 所以一直没被发现，直到把缓存去掉才暴露。
   */
  private nodeIn(file: TreeFile, id: string): TreeNode {
    const n = file.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`没有这个节点：${id}`);
    return n;
  }

  /** 加节点：给了 parentId 就是子任务，给了 siblingOf 就是同级任务。 */
  add(opts: { parentId?: string; siblingOf?: string; title: string; intent?: string }): TreeNode {
    const file = this.load();
    if (!file) throw new Error('还没有任务树（先 tree_create）');
    const limit = this.settings.maxNodes;
    if (file.nodes.length >= limit) throw new Error(`节点数已达上限 ${limit}（防止无限分裂）；请先收掉分支再长`);

    let parentId: string | null = null;
    if (opts.siblingOf) {
      const sib = this.nodeIn(file, opts.siblingOf);
      parentId = sib.parentId;
    } else if (opts.parentId) {
      parentId = this.nodeIn(file, opts.parentId).id;
    } else {
      throw new Error('给 parentId（子任务）或 siblingOf（同级任务）之一');
    }
    const at = NOW();
    const node: TreeNode = {
      id: `n${file.nodes.length + 1}`, parentId, title: opts.title, intent: opts.intent,
      kind: parentId && this.nodeIn(file, parentId).parentId === null ? 'task' : 'subtask',
      status: 'pending', dependsOn: [], evidence: [], decisions: [], questions: [],
      attempts: 0, log: [], createdAt: at, updatedAt: at,
    };
    file.nodes.push(node);
    file.updatedAt = at;
    this.save(file);
    return node;
  }

  /** 改状态 / 记证据 / 记决策。 */
  update(id: string, opts: {
    status?: TreeStatus;
    note?: string;
    evidence?: string[];
    decision?: { choice: string; why: string; auto?: boolean };
  }): TreeNode {
    const file = this.load();
    if (!file) throw new Error('还没有任务树');
    const node = this.nodeIn(file, id);
    const from = node.status;
    if (opts.status) {
      node.status = opts.status;
      if (opts.status === 'blocked') node.attempts += 1;
      if (from !== opts.status) {
        node.log.push({ at: NOW(), from, to: opts.status, ...(opts.note ? { note: opts.note } : {}) });
        if (node.log.length > 200) node.log.splice(0, node.log.length - 200);
      }
    }
    if (opts.note !== undefined) node.note = opts.note;
    for (const e of opts.evidence ?? []) if (!node.evidence.includes(e)) node.evidence.push(e);
    if (opts.decision) node.decisions.push({ at: NOW(), choice: opts.decision.choice, why: opts.decision.why, auto: opts.decision.auto === true });
    node.updatedAt = NOW();
    file.updatedAt = node.updatedAt;
    this.save(file);
    return node;
  }

  /**
   * 提问：挂起该分支，其他分支继续。
   *
   * 到期结算在 `sweep()` 里做（用 deadlineAt，不靠内存定时器 —— 重启不丢）。
   */
  ask(id: string, q: { text: string; options: string[]; recommend: string; blocking?: boolean; reversible?: boolean }): TreeQuestion {
    const file = this.load();
    if (!file) throw new Error('还没有任务树');
    const node = this.nodeIn(file, id);
    const at = NOW();
    const question: TreeQuestion = {
      id: randomUUID().slice(0, 8),
      text: q.text,
      options: q.options,
      recommend: q.recommend,
      blocking: q.blocking === true,
      reversible: q.reversible !== false,
      askedAt: at,
      deadlineAt: new Date(Date.now() + this.settings.answerTimeoutMs).toISOString(),
    };
    node.questions.push(question);
    if (node.status === 'active' || node.status === 'pending') node.status = 'shelved';
    node.updatedAt = at;
    file.updatedAt = at;
    this.save(file);
    return question;
  }

  /** 人工回答（UI/工具）。 */
  answer(id: string, questionId: string, answer: string): TreeQuestion {
    const file = this.load();
    if (!file) throw new Error('还没有任务树');
    const node = this.nodeIn(file, id);
    const q = node.questions.find((x) => x.id === questionId);
    if (!q) throw new Error(`没有这个问题：${questionId}`);
    q.answer = answer;
    q.answeredAt = NOW();
    if (node.status === 'shelved') node.status = 'active';
    node.updatedAt = NOW();
    file.updatedAt = node.updatedAt;
    this.save(file);
    return q;
  }

  /**
   * 到期的提问怎么处理。
   *
   * 规则（按用户要求）：
   *   1. **不可逆**的问题永远不走自动 → 保持搁置；
   *   2. 设置"相信" → 采纳 recommend（标记 autoAnswered，并在 decisions 里留痕）；
   *   3. 设置"不相信" → 保持搁置；若 blocking=true，判定树受阻（返回 blocked=true）。
   */
  sweep(): { auto: TreeQuestion[]; stillPending: TreeQuestion[]; blocked: boolean } {
    const file = this.load();
    if (!file) return { auto: [], stillPending: [], blocked: false };
    const now = Date.now();
    const auto: TreeQuestion[] = [];
    const stillPending: TreeQuestion[] = [];
    let blocked = false;

    for (const node of file.nodes) {
      for (const q of node.questions) {
        if (q.answeredAt) continue;
        if (Date.parse(q.deadlineAt) > now) { stillPending.push(q); continue; }
        if (!q.reversible) { stillPending.push(q); if (q.blocking) blocked = true; continue; }
        if (this.settings.trustModel) {
          q.answer = q.recommend;
          q.answeredAt = NOW();
          q.autoAnswered = true;
          node.decisions.push({ at: NOW(), choice: q.recommend, why: `无人值守自动采纳（提问 ${q.id} 超时未答，设置=相信）`, auto: true });
          if (node.status === 'shelved') node.status = 'active';
          auto.push(q);
        } else {
          stillPending.push(q);
          if (q.blocking) blocked = true;
        }
      }
    }
    if (auto.length || blocked) { file.updatedAt = NOW(); this.save(file); }
    return { auto, stillPending, blocked };
  }

  /**
   * 该收口了没有。
   *
   * 出口不能只靠模型自己想起来 —— 墙钟、节点数、单节点失败次数任何一个到顶，这棵树继续跑
   * 只是在烧时间和钱。判断放在这里，由 `tree_get`（模型每一步都会顺手看一眼）报出来，
   * 而不是等它自觉调用 `tree_report`。
   */
  budget(): { exhausted: boolean; reason: string } {
    const file = this.load();
    if (!file) return { exhausted: false, reason: '' };
    const open = file.nodes.filter((n) => n.status !== 'done' && n.status !== 'dropped');
    if (!open.length) return { exhausted: false, reason: '' };
    const minutes = (Date.now() - Date.parse(file.createdAt)) / 60_000;
    if (minutes >= this.settings.maxMinutes) {
      return { exhausted: true, reason: `已跑 ${Math.round(minutes)} 分钟，超过预算 ${this.settings.maxMinutes} 分钟` };
    }
    if (file.nodes.length >= this.settings.maxNodes) {
      return { exhausted: true, reason: `节点数 ${file.nodes.length} 已达上限 ${this.settings.maxNodes}` };
    }
    const dead = open.find((n) => n.attempts >= this.settings.maxNodeAttempts);
    if (dead) return { exhausted: true, reason: `${dead.id}「${dead.title}」已连续失败 ${dead.attempts} 次` };
    return { exhausted: false, reason: '' };
  }
  /**
   * 记一次出口汇报并**落盘**。
   *
   * 原来 `tree_report` 只做了 `file.reports.push(...)` —— 改的是 `get()` 返回的那个内存对象，
   * 从来没有 save。后果有两个：汇报在重启后消失；`treeAutopilot` 看 `reports.length` 判断
   * "已经收口"，于是永远判成没收口、无限续跑。
   */
  /** 刹车：写一个 aborted 标记，下一次 autopilot 判断立刻停。 */
  halt(reason: string): void {
    const file = this.load();
    if (!file) return;
    file.aborted = { at: NOW(), reason };
    file.updatedAt = NOW();
    this.save(file);
  }

  /** 解除急停：把 aborted 清掉，自动续跑恢复。 */
  resume(): void {
    const file = this.load();
    if (!file) return;
    delete file.aborted;
    file.updatedAt = NOW();
    this.save(file);
  }  recordReport(outcome: 'success' | 'blocked' | 'partial', summary: string): void {
    const file = this.load();
    if (!file) return;
    file.reports.push({ at: NOW(), outcome, summary });
    file.updatedAt = NOW();
    this.save(file);
  }

  /** 出口判定：没有可推进节点时，是"全完成"还是"受阻/预算用尽"。 */
  outcome(startedAt: number): { outcome: 'success' | 'blocked' | 'partial'; reason: string } {
    const file = this.load();
    if (!file) return { outcome: 'blocked', reason: '还没有任务树' };
    const open = file.nodes.filter((n) => n.status !== 'done' && n.status !== 'dropped');
    if (!open.length) return { outcome: 'success', reason: '所有节点都已完成或明确放弃' };
    const stuck = open.filter((n) => n.status === 'blocked' || n.status === 'shelved');
    if (stuck.length === open.length) {
      return { outcome: 'blocked', reason: `所有剩余节点都卡住：${stuck.map((n) => `${n.id} ${n.title}(${n.status})`).join('、')}` };
    }
    const overTime = Date.now() - startedAt > this.settings.maxMinutes * 60_000;
    const overTries = open.some((n) => n.attempts >= this.settings.maxNodeAttempts);
    if (overTime || overTries) {
      return {
        outcome: 'partial',
        reason: overTime ? `超过时间预算 ${this.settings.maxMinutes} 分钟` : `有节点已连续失败 ${this.settings.maxNodeAttempts} 次`,
      };
    }
    return { outcome: 'partial', reason: '仍有可推进的节点，但本轮到此为止' };
  }
}


export interface TreeAutopilotDecision {
  /** True when the turn should keep going instead of handing control back. */
  proceed: boolean;
  /** The message that resumes the work, when `proceed`. */
  nudge?: string;
  /** Node statuses, so the caller can tell a round that moved the tree from one that did not. */
  signature: string;
  /** Why it stopped, for the status line. */
  reason?: string;
}

/**
 * 这棵任务树该不该让这一轮继续跑。
 *
 * 「任务树是个自动跑的高级计划」—— 用户 2026-11-01 的原话。第一版把它做成了"只在出口汇报、
 * 不推动"，于是模型干完一段就停下来等人：那不是高级计划，那是会写日记的待办清单。
 *
 * 判定与 `planAutopilot` 同构（同样只看这一轮动过的树、同样只在真的走不下去时交还），差别是
 * 停下条件按树的语义：
 *   - 已经 tree_report 过（收口）→ 停；
 *   - 有 blocking 问题还没答案 → 停（那是在等你）；
 *   - 预算到顶（墙钟/节点数/单节点失败）→ 停，让模型去 tree_report；
 *   - 没有可推进的节点 → 停；
 *   - 回复以问号结尾 → 停（模型在问你）。
 */
export function treeAutopilot(
  store: TaskTreeStore,
  opts: { turnStartedAt: number; reply: string },
): TreeAutopilotDecision {
  const file = store.get();
  const signature = file ? file.nodes.map((n) => `${n.id}:${n.status}`).join(',') : '';
  if (!file) return { proceed: false, signature, reason: '没有任务树' };
  if (file.aborted) return { proceed: false, signature, reason: `已被急停：${file.aborted.reason}（tree_update 里清掉 aborted 可恢复）` };
  if (file.reports.length > 0) return { proceed: false, signature, reason: '这棵树已经 tree_report 过了' };
  if (Date.parse(file.updatedAt) < opts.turnStartedAt) {
    return { proceed: false, signature, reason: '这棵树不是这一轮在推进的' };
  }

  /* 有人没答的 blocking 问题 = 在等你，自动续跑只会空转。 */
  const waiting = file.nodes
    .flatMap((n) => n.questions.map((q) => ({ n, q })))
    .filter(({ q }) => !q.answeredAt && q.blocking);
  if (waiting.length) {
    const { n, q } = waiting[0]!;
    return { proceed: false, signature, reason: `在等你回答：${q.text}（节点 ${n.id}）` };
  }

  const budget = store.budget();
  if (budget.exhausted) {
    return { proceed: false, signature, reason: `预算用尽：${budget.reason} —— 该 tree_report 了` };
  }

  const open = file.nodes.filter((n) => n.status !== 'done' && n.status !== 'dropped');
  if (!open.length) return { proceed: false, signature, reason: '所有节点都已完成或放弃' };

  const runnable = open.filter((n) => n.status === 'active' || n.status === 'pending');
  if (!runnable.length) {
    return { proceed: false, signature, reason: `没有可推进的节点（剩下的都在等：${open.map((n) => `${n.id}=${n.status}`).join('、')}）` };
  }

  if (/[?？]\s*$/.test(String(opts.reply ?? '').trim())) {
    return { proceed: false, signature, reason: '在等你回答问题' };
  }

  const next = runnable.find((n) => n.status === 'active') ?? runnable[0]!;
  return {
    proceed: true,
    signature,
    nudge: `[自动续跑] 任务树还有 ${open.length} 个节点没做完，下一个可推进的是「${next.title}」（${next.id}）。`
      + '先 tree_get 看一眼当前状态，然后直接干活：做完用 tree_update 记状态与证据；'
      + '发现新分支就 tree_add 长出来；只有需要我提供只有我知道的信息、或要做不可逆的操作时才 tree_ask。'
      + '不要停下来等我确认。全部做完、真的受阻、或预算用尽时，用 tree_report 收口。',
  };
}
