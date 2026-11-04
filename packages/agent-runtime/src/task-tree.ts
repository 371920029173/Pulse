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
 * 存储：`.she/sessions/<会话>/trees/<treeId>.json`，当前是哪一棵记在 `trees/active`。
 * 一个会话可以有**多棵**树（用户 2026-11-04："允许模型删除任务树、创建任务树（无论是否已有）"），
 * 但删到一棵不剩会被**拒绝**：没有当前树时所有 tree_* 都没有落点，那个状态在用户眼里就是"树丢了"。
 * 坏文件隔离、写入加锁，与 plans.json 同一套纪律。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
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

/** `list()` 的一行：够你在几棵之间挑一棵，不含节点正文。 */
export interface TreeSummary {
  id: string;
  title: string;
  done: number;
  total: number;
  active: boolean;
  reports: number;
  updatedAt: string;
}

export interface TreeSettings {
  /** 相信模型 → 到期自动采纳推荐值；默认不信任（安全侧）。 */
  trustModel: boolean;
  answerTimeoutMs: number;
  /** 墙钟预算（分钟）。**不设 = 不限制**；设 0 = 立刻到顶。 */
  maxMinutes?: number;
  maxNodeAttempts: number;
  /** 节点数上限。**不设 = 不限制**；设 0 = 立刻到顶。 */
  maxNodes?: number;
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
    // 预算两项：只有用户显式设置了才有上限；不设 = 不限制（用户 2026-11-02 的口径）
    ...(env.SHE_TREE_MAX_MINUTES !== undefined && Number(env.SHE_TREE_MAX_MINUTES) >= 0
      ? { maxMinutes: Math.floor(Number(env.SHE_TREE_MAX_MINUTES)) } : {}),
    ...(env.SHE_TREE_MAX_NODES !== undefined && Number(env.SHE_TREE_MAX_NODES) >= 0
      ? { maxNodes: Math.floor(Number(env.SHE_TREE_MAX_NODES)) } : {}),
    maxNodeAttempts: num('SHE_TREE_MAX_TRIES', 3),
    // （maxNodes 只由上面那行"显式设置才加"给值；这里再写一次会把"不限制"和 0 都覆盖成 60）
    backupBeforeAuto: true,
  };
}

export const DEFAULT_TREE_SETTINGS: TreeSettings = {
  trustModel: false,
  answerTimeoutMs: 5 * 60_000,
  // 预算不设 = 不限制
  maxNodeAttempts: 3,
  backupBeforeAuto: true,
};

const NOW = () => new Date().toISOString();

/** 当前活动树记在这个文件里（内容就是树 id，一行）。 */
const ACTIVE_NAME = 'active';

/** 树 id 的形状：进文件名，所以只允许文件系统安全的字符。 */
const TREE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
  /** 一棵树一个文件，就在这个目录里。 */
  private treesDir: string;
  /** 旧版单文件（每会话一棵）：只在迁移时读一次，之后原样留着。 */
  private legacyFile: string;
  /** 本次 load/save 面对的那棵树。active 变了它就跟着变；没有树时为 null。 */
  private file: string | null = null;
  private recovery: { backup: string; reason: string } | null = null;
  private data: TreeFile | null = null;
  /**
   * 迁移只做一次（每个实例一次）。
   *
   * 不设这个标记的话，每次 `load()` 都会去 stat 一次旧文件 —— 而迁移会把旧文件改名，
   * 于是"改名失败"（权限/被占用）时每次访问都会尝试一遍复制，写出第二棵一模一样的树。
   */
  private migrateTried = false;

  constructor(private workspaceRoot: string, private sessionId: string, settings?: TreeSettings) {
    this.settings = settings ?? treeSettingsFromEnv();
    this.dir = sessionStateDir(workspaceRoot, sessionId);
    this.treesDir = join(this.dir, 'trees');
    this.legacyFile = join(this.dir, 'tree.json');
  }

  recoveryInfo(): { backup: string; reason: string } | null {
    return this.recovery;
  }

  /* ────────────────────────── 路径与目录 ────────────────────────── */

  private treePath(id: string): string {
    // 白名单而不是"拼一下试试"：id 会进文件名，`..` 拼进去就是逃出这个会话的目录。
    if (!TREE_ID_RE.test(id) || id.includes('..')) throw new Error(`任务树 id 不合法：${JSON.stringify(id)}`);
    return join(this.treesDir, `${id}.json`);
  }

  /** 这个会话现有的树 id（按名字排序，稳定）。读不懂的文件不在这里（它们已被隔离成 .corrupt-*）。 */
  private treeIds(): string[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.treesDir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      // 只认能拼回同一个路径的名字：手工塞进来的怪名字当"不认识"，而不是当成一棵树。
      .filter((id) => TREE_ID_RE.test(id) && !id.includes('..'))
      .sort();
  }

  private activePath(): string {
    return join(this.treesDir, ACTIVE_NAME);
  }

  private writeActive(id: string): void {
    mkdirSync(this.treesDir, { recursive: true });
    const path = this.activePath();
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, id, 'utf8');
    renameSync(tmp, path);
  }

  private newId(): string {
    // 时间前缀让人一眼看出先后，随机后缀防止同一毫秒建两棵撞名。
    return `t${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
  }

  /**
   * 首次访问时的迁移：旧版每会话一棵 `tree.json` → `trees/<id>.json`。
   *
   * 三个决定值得写下来：
   *   1. **原文件不删**，改名为 `tree.json.migrated-<ts>`（用户 2026-11-04："迁移旧文件时不得删除原文件"）。
   *      迁移是"复制并留证"，不是"搬走"：删掉它等于把回滚的可能也删掉了，而这份数据是用户
   *      唯一的一份任务历史。
   *   2. 只在 `trees/` 里**一个 .json 都没有**时才迁。否则已经在新布局上了，再把旧文件塞进来
   *      会凭空多出一棵谁也认不出来的树。
   *   3. 迁完写 `trees/active` 指向新 id。不写的话下一次访问就得靠"猜一棵"，而猜错的表现
   *      是"读到另一棵树上"—— 在用户眼里就是树丢了。
   */
  private migrateLegacy(): void {
    if (this.migrateTried) return;
    this.migrateTried = true;
    if (!existsSync(this.legacyFile)) return;
    if (this.treeIds().length) return;
    /*
     * 用 readTreeFile 而不是裸 JSON.parse：读不懂的旧文件必须走同一条隔离路径
     * （改名成 .corrupt-<ts> 并让 recoveryInfo 报出来），否则"迁移"会把一份坏文件
     * 变成一棵……不存在的树，而用户不会被告知任何事。
     */
    const old = readTreeFile(this.legacyFile, (backup, reason) => { this.recovery = { backup, reason }; });
    if (!old) return;
    const id = this.newId();
    try {
      mkdirSync(this.treesDir, { recursive: true });
      this.writeTree(this.treePath(id), old);
      this.writeActive(id);
    } catch (err) {
      // 复制失败就别改名：旧文件必须留在原地，下一次访问还能重试。
      this.recovery = { backup: this.legacyFile, reason: `迁移失败：${(err as Error)?.message ?? String(err)}` };
      return;
    }
    try {
      renameSync(this.legacyFile, `${this.legacyFile}.migrated-${NOW().replace(/[:.]/g, '-')}`);
    } catch { /* 改不动也留着原名：内容已经复制过去了，不丢 */ }
  }

  /* ────────────────────────── 读 / 写 ────────────────────────── */

  /**
   * 当前是哪一棵。
   *
   * 指针丢失或指向一棵已经删掉的树时**修指针而不是报错**：能读到的树就不该因为一行指针坏了
   * 变成"没有任务树"。挑最近更新的那棵，并把指针补回去。
   */
  activeId(): string | null {
    this.migrateLegacy();
    const ids = this.treeIds();
    if (!ids.length) return null;
    let pointer = '';
    try {
      pointer = readFileSync(this.activePath(), 'utf8').trim();
    } catch { /* 还没有 active 文件 */ }
    if (pointer && ids.includes(pointer)) return pointer;
    const picked = this.pickMostRecent(ids);
    try { this.writeActive(picked); } catch { /* 指针写不进去也照样能读 */ }
    return picked;
  }

  /**
   * 指针丢了时挑哪一棵：最近改动过的那棵。
   *
   * 用 `updatedAt` 而不是文件 mtime：任务树每次写都是"读进来改完整体重写"，两者大体一致，
   * 但 updatedAt 是内容自己声明的，跨文件系统/拷贝之后仍然是对的。读不懂的一律排最后。
   */
  private pickMostRecent(ids: string[]): string {
    let best = ids[0]!;
    let bestAt = '';
    for (const id of ids) {
      let at = '';
      try {
        const f = JSON.parse(readFileSync(this.treePath(id), 'utf8').replace(/^\uFEFF/, '')) as TreeFile;
        at = String(f.updatedAt ?? '');
      } catch { at = ''; }
      if (at > bestAt) { bestAt = at; best = id; }
    }
    return best;
  }

  /** 每次真读盘：同一会话有多个实例（工具侧 / autopilot），内存缓存会让它们各自停在旧快照上。 */
  private load(): TreeFile | null {
    const id = this.activeId();
    if (!id) {
      this.file = null;
      this.data = null;
      return null;
    }
    this.file = this.treePath(id);
    const loaded = readTreeFile(this.file, (backup, reason) => { this.recovery = { backup, reason }; });
    this.data = loaded;
    return loaded;
  }

  /** 写入**当前那棵**：加锁（跨进程）+ 原子替换，与 plans.json 同一套。 */
  private save(next: TreeFile): void {
    if (!this.file) throw new Error('没有当前任务树（先 tree_create）');
    this.writeTree(this.file, next);
    this.data = next;
  }

  private writeTree(path: string, next: TreeFile): void {
    mkdirSync(this.treesDir, { recursive: true });
    const lock = `${path}.lock`;
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
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmp, path);
    } finally {
      try { unlinkSync(lock); } catch { /* ignore */ }
    }
  }

  get(): TreeFile | null {
    return this.load();
  }

  /* ────────────────────────── 多棵树 ────────────────────────── */

  /**
   * 列出这个会话的所有树（当前那棵排第一，并标 active）。
   *
   * `done` / `total` 不含根节点，与 `renderTree` 的分母一致 —— 两处算法要是不一样，
   * 用户在列表里看到 3/3、点进去看到 2/3 这种"同一棵两个数"就会发生。
   */
  list(): TreeSummary[] {
    this.migrateLegacy();
    const active = this.activeId();
    const out: TreeSummary[] = [];
    for (const id of this.treeIds()) {
      const file = readTreeFile(this.treePath(id), (backup, reason) => { this.recovery = { backup, reason }; });
      if (!file) continue; // 坏文件已被隔离；recoveryInfo 会告诉用户到哪里去找
      const tasks = (file.nodes ?? []).filter((n) => n.id !== file.rootId);
      const root = (file.nodes ?? []).find((n) => n.id === file.rootId);
      out.push({
        id,
        title: root?.title ?? '（空树）',
        done: tasks.filter((n) => n.status === 'done').length,
        total: tasks.length,
        active: id === active,
        reports: (file.reports ?? []).length,
        updatedAt: String(file.updatedAt ?? ''),
      });
    }
    out.sort((a, b) => (a.active === b.active ? b.updatedAt.localeCompare(a.updatedAt) : a.active ? -1 : 1));
    return out;
  }

  /** 建好一棵树的数据（不落盘）。create / createNew 共用，好让两棵树的构造规则不可能分叉。 */
  private buildTree(title: string, intent?: string, subtasks: string[] = []): TreeFile {
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
    return { v: 1, sessionId: this.sessionId, rootId: root.id, nodes, createdAt: at, updatedAt: at, reports: [] };
  }

  /**
   * 总是新建一棵，并把它设为当前树。
   *
   * 与 `create()` 的差别就是"不再拒绝"（用户 2026-11-04：创建任务树"无论是否已有"）：
   * 用户要开第二件事的时候，被迫把第一棵的节点全标掉才能开工，那不是约束，那是刁难。
   */
  createNew(title: string, intent?: string, subtasks: string[] = []): TreeFile {
    this.migrateLegacy();
    const file = this.buildTree(title, intent, subtasks);
    const id = this.newId();
    const path = this.treePath(id);
    this.writeTree(path, file);
    this.writeActive(id);
    this.file = path;
    this.data = file;
    return file;
  }

  /** 建根（一棵树只有一根）。已有当前树时仍然拒绝 —— 要另起一棵请用 createNew。 */
  create(title: string, intent?: string, subtasks: string[] = []): TreeFile {
    const existing = this.load();
    if (existing?.rootId) {
      throw new Error('当前这棵任务树已经建好了；要在这棵树上加子任务用 tree_add，'
        + '要另起一棵（这个会话可以有不止一棵树）用 tree_create（它会成为当前树）');
    }
    return this.createNew(title, intent, subtasks);
  }

  /** 切到另一棵树。不存在就报错，并把现有的列出来 —— 只报"没有"等于让调用方去猜。 */
  switch(id: string): TreeFile {
    this.migrateLegacy();
    const ids = this.treeIds();
    if (!ids.includes(id)) {
      throw new Error(`没有这棵任务树：${id}（现有：${ids.join('、') || '一棵都没有'}）`);
    }
    this.writeActive(id);
    this.file = this.treePath(id);
    this.data = null;
    const loaded = this.load();
    if (!loaded) throw new Error(`任务树 ${id} 读不出来（文件可能刚被删或损坏）；用 tree_list 看现有哪几棵`);
    return loaded;
  }

  /**
   * 删掉一棵树。
   *
   * **删完一棵不剩就拒绝**：所有 tree_* 都作用在"当前树"上，没有当前树时 tree_get 会报
   * "还没有任务树"、tree_update 会报"没有这个节点"—— 那些提示会让模型以为树坏了，
   * 于是重新建一棵、把刚才的进展全丢掉。宁可拒绝，也不要进入那个状态。
   *
   * 删的是当前树时，指针改指到剩下最近的那一棵（走 `activeId()` 的修补逻辑），
   * 而不是留在原地指向一个已经不存在的文件。
   */
  remove(id: string): { id: string; activeId: string } {
    this.migrateLegacy();
    const ids = this.treeIds();
    if (!ids.includes(id)) {
      throw new Error(`没有这棵任务树：${id}（现有：${ids.join('、') || '一棵都没有'}）`);
    }
    if (ids.length <= 1) {
      throw new Error(`不能删「${id}」：这是这个会话最后一棵任务树，删掉就没有当前树了 —— `
        + '一个会话至少要保留一棵（否则 tree_get / tree_update / tree_report 都没有落点，'
        + '看起来就像树丢了）。要换内容请先用 tree_create 建一棵新的（它会成为当前树），再删这棵。');
    }
    unlinkSync(this.treePath(id));
    this.file = null;
    this.data = null;
    const next = this.activeId();
    // activeId() 只在指针丢掉/悬空时才重算；删掉的正好是当前树时，这两种情况都成立。
    if (!next) throw new Error(`删掉 ${id} 之后找不到剩下的任务树（目录：${this.treesDir}）`);
    return { id, activeId: next };
  }

  /* ────────────────────────── 当前树上的操作 ────────────────────────── */

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
    if (typeof limit === 'number' && file.nodes.length >= limit) throw new Error(`节点数已达上限 ${limit}（防止无限分裂）；请先收掉分支再长`);

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
    /** 允许把 done/dropped 的节点重开。只给"确实要重开"的场景用，它会在时间线里留痕。 */
    force?: boolean;
  }): TreeNode {
    const file = this.load();
    if (!file) throw new Error('还没有任务树');
    const node = this.nodeIn(file, id);
    const from = node.status;
    if (opts.status) {
      const from = node.status;
      if (from === 'done' && opts.status !== 'done' && opts.force !== true) {
        throw new Error(`节点 ${id} 已经是 done，不能改回 ${opts.status}（要重开请显式 force: true，它会留在时间线里）`);
      }
      if (from === 'dropped' && opts.status !== 'dropped' && opts.force !== true) {
        throw new Error(`节点 ${id} 已经 dropped，不能改回 ${opts.status}（要重开请显式 force: true）`);
      }
      node.status = opts.status;
      if (opts.status === 'blocked') node.attempts += 1;
      /*
       * 回到 active/done 就把计数清零：`attempts` 的语义（budget() 的文案、outcome() 的判断）是
       * **连续**失败。原来只加不减，于是一个已经修好、正在推进的节点在历史上撞过 3 次之后，
       * budget() 永远判"预算用尽"，tree_get 一直喊必须收口，这个节点再也推不动。
       */
      else node.attempts = 0;
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
    const open = file.nodes.filter((n) => n.id !== file.rootId && n.status !== 'done' && n.status !== 'dropped');
    if (!open.length) return { exhausted: false, reason: '' };
    const minutes = (Date.now() - Date.parse(file.createdAt)) / 60_000;
    /*
     * 预算不设 = 不限制（用户 2026-11-02 的口径）。`0` 仍然有含义：立刻到顶。
     * 所以判的是 `typeof === number`，不是"有没有值"。
     */
    if (typeof this.settings.maxMinutes === 'number' && minutes >= this.settings.maxMinutes) {
      return { exhausted: true, reason: `这棵树已经跑了 ${Math.round(minutes)} 分钟，你设的上限是 ${this.settings.maxMinutes} 分钟` };
    }
    if (typeof this.settings.maxNodes === 'number' && file.nodes.length >= this.settings.maxNodes) {
      return { exhausted: true, reason: `节点数是 ${file.nodes.length}，你设的上限是 ${this.settings.maxNodes}` };
    }
    const dead = open.find((n) => n.attempts >= this.settings.maxNodeAttempts);
    if (dead) return { exhausted: true, reason: `${dead.id}「${dead.title}」已连续失败 ${dead.attempts} 次` };
    return { exhausted: false, reason: '' };
  }

  /**
   * 刹车：写一个 aborted 标记，下一次 autopilot 判断立刻停。
   *
   * 它只动**当前这棵**：另一棵树上正在跑的东西不该因为这一棵被叫停而停下。
   */
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
  }

  /**
   * 记一次出口汇报并**落盘**。
   *
   * 原来 `tree_report` 只做了 `file.reports.push(...)` —— 改的是 `get()` 返回的那个内存对象，
   * 从来没有 save。后果有两个：汇报在重启后消失；`treeAutopilot` 看 `reports.length` 判断
   * "已经收口"，于是永远判成没收口、无限续跑。
   */
  recordReport(outcome: 'success' | 'blocked' | 'partial', summary: string): void {
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
    const open = file.nodes.filter((n) => n.id !== file.rootId && n.status !== 'done' && n.status !== 'dropped');
    if (!open.length) return { outcome: 'success', reason: '所有节点都已完成或明确放弃' };
    const stuck = open.filter((n) => n.status === 'blocked' || n.status === 'shelved');
    if (stuck.length === open.length) {
      return { outcome: 'blocked', reason: `所有剩余节点都卡住：${stuck.map((n) => `${n.id} ${n.title}(${n.status})`).join('、')}` };
    }
    const overTime = typeof this.settings.maxMinutes === 'number'
      && Date.now() - startedAt > this.settings.maxMinutes * 60_000;
    const overTries = open.some((n) => n.attempts >= this.settings.maxNodeAttempts);
    if (overTime || overTries) {
      return {
        outcome: 'partial',
        reason: overTime ? `跑得比你设的 ${this.settings.maxMinutes} 分钟久` : `有节点已连续失败 ${this.settings.maxNodeAttempts} 次`,
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
 *
 * 多棵树之后它看的是**当前那棵**（`store.get()` 就是 active）：另一棵收口了不代表这棵也该停，
 * 反过来也一样。判据 ⑳ 钉的就是这一条。
 */
export function treeAutopilot(
  store: TaskTreeStore,
  opts: { turnStartedAt: number; reply: string },
): TreeAutopilotDecision {
  const file = store.get();
  const signature = file ? file.nodes.map((n) => `${n.id}:${n.status}`).join(',') : '';
  if (!file) return { proceed: false, signature, reason: '没有任务树' };
  if (file.aborted) return { proceed: false, signature, reason: `已被急停：${file.aborted.reason}（tree_update 里清掉 aborted 可恢复）` };
  const lastReport = file.reports[file.reports.length - 1];
  if (lastReport && lastReport.outcome === 'success') {
    return { proceed: false, signature, reason: '这棵树已经收口（success）' };
  }
  /*
   * 不再看"是不是这一轮动过的"：树是每会话私有，文件位置已经回答了归属问题。
   * 原来那条闸是从 plan 抄过来的（plan 是工作区级、跨会话共享，才需要它），抄到树上就变成
   * "重启一次或隔一轮说继续，树就再也不自动跑"。真正该拦的是下面这几条：已报告、已急停、
   * 有人在等你回答、没有可推进的节点。
   */

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
    return { proceed: false, signature, reason: `到这里为止：${budget.reason} —— 该收口了（tree_report）` };
  }

  const open = file.nodes.filter((n) => n.id !== file.rootId && n.status !== 'done' && n.status !== 'dropped');
  if (!open.length) return { proceed: false, signature, reason: '所有节点都已完成或放弃' };

  const runnable = open.filter((n) => n.status === 'active' || n.status === 'pending');
  if (!runnable.length) {
    return { proceed: false, signature, reason: `没有可推进的节点（剩下的都在等：${open.map((n) => `${n.id}=${n.status}`).join('、')}）` };
  }

  /*
   * 这里**不再**用"回复以问号结尾"当作停止条件（2026-11-04）：
   * 树续跑一轮后回复常以"要不要我…？"收尾，那条规则会让它每次只跑一轮。
   * 真要求人回答请用 `tree_ask`（带 deadline / blocking）；标点不是提问通道。
   */

  const next = runnable.find((n) => n.status === 'active') ?? runnable[0]!;
  return {
    proceed: true,
    signature,
    nudge: `[自动续跑] 任务树还有 ${open.length} 个节点没做完，下一个可推进的是「${next.title}」（${next.id}）。`
      + '先 tree_get 看一眼当前状态，然后直接干活：做完用 tree_update 记状态与证据；'
      + '发现新分支就 tree_add 长出来；只有需要我提供只有我知道的信息、或要做不可逆的操作时才 tree_ask。'
      + '不要停下来等我确认。全部做完、真的受阻、或到你设的上限了时，用 tree_report 收口。',
  };
}
