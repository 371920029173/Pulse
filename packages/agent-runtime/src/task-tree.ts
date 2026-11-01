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
    if (this.data) return this.data;
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

  private node(id: string): TreeNode {
    const file = this.load();
    if (!file) throw new Error('还没有任务树（先 tree_create）');
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
      const sib = this.node(opts.siblingOf);
      parentId = sib.parentId;
    } else if (opts.parentId) {
      parentId = this.node(opts.parentId).id;
    } else {
      throw new Error('给 parentId（子任务）或 siblingOf（同级任务）之一');
    }
    const at = NOW();
    const node: TreeNode = {
      id: `n${file.nodes.length + 1}`, parentId, title: opts.title, intent: opts.intent,
      kind: parentId && this.node(parentId).parentId === null ? 'task' : 'subtask',
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
    const node = this.node(id);
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
    const node = this.node(id);
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
    const node = this.node(id);
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
