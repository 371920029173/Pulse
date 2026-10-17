/*
 * git 层：只调 CLI，不内嵌 git 实现。
 *
 * 用户问过"git 不是开源的吗，砍了装进来行不行"。不行的理由是这个模块存在的全部理由：
 * git 的对象存储与工作区语义（packed-refs、CRLF、大小写不敏感文件系统、submodule、
 * shallow clone……）是几十万行边界情况的集合，砍出来的版本会**安静地算错**，而回退算错
 * 等于丢代码。这里只做三件事：读状态、读历史、按路径回退。
 *
 * 回退是唯一会毁数据的操作，所以它被拆成四步，且每一步都可以单独拒绝：
 *
 *   1. planRevert()    出计划：每个文件当前/目标 diff、**是否脏**、是否存在于目标 rev
 *   2. createTicket()  确认票据：把计划哈希写盘，执行时必须带回来（单次有效）
 *   3. snapshot()      快照：动手前把当前内容原样存到 .she/map/snapshots/<ts>/
 *   4. executeRevert() 执行：验票据 → 拍快照 → git restore
 *
 * 工作区脏的文件默认**直接阻断**（blockers），因为 git restore 会覆盖用户没提交的改动，
 * 那是不可恢复的。要强行回退得显式传 allowDirty，且仍然会先拍快照。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mapDir } from './store.js';

export function gitIn(root: string) {
  return (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

export interface StatusEntry {
  path: string;
  /** 工作区状态：M 改、D 删、? 未跟踪、R 改名、U 冲突。 */
  worktree: string;
  staged: string;
}

/** `--porcelain=v2 -z`：机器可读、路径不转义（`-z` 关键，否则中文路径会被加引号）。 */
export function status(root: string, git = gitIn(root)): StatusEntry[] {
  const raw = git(['status', '--porcelain=v2', '-z']);
  const out: StatusEntry[] = [];
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const kind = entry[0];
    if (kind === '?') {
      out.push({ path: entry.slice(2), worktree: '?', staged: '.' });
      continue;
    }
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue;
    const parts = entry.split(' ');
    const xy = parts[1] ?? '..';
    const path = kind === '2' ? parts.slice(9).join(' ') : parts.slice(8).join(' ');
    out.push({ path, worktree: xy[1] ?? '.', staged: xy[0] ?? '.' });
  }
  return out;
}

export interface NumStat {
  path: string;
  added: number;
  removed: number;
}

/** 改动统计（相对某个 rev；不传 rev 就是工作区 vs HEAD）。 */
export function numStat(root: string, rev: string | null, paths: string[], git = gitIn(root)): NumStat[] {
  const args = ['-c', 'core.quotepath=false', 'diff', '--numstat'];
  if (rev) args.push(rev);
  if (paths.length) args.push('--', ...paths);
  const raw = git(args);
  const out: NumStat[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue;
    out.push({
      path: m[3]!.replace(/\\/g, '/'),
      added: m[1] === '-' ? -1 : Number(m[1]),
      removed: m[2] === '-' ? -1 : Number(m[2]),
    });
  }
  return out;
}

/** 某文件在某个 rev 下的内容（用于"之前什么样"）。不存在时返回 null。 */
export function show(root: string, rev: string, path: string, git = gitIn(root)): string | null {
  try {
    return git(['show', `${rev}:${path}`]);
  } catch {
    return null;
  }
}

/** 文件级提交历史（跟改名走），给"改了什么 / 为什么"用。 */
export interface CommitLite {
  sha: string;
  at: string;
  subject: string;
}

export function logForPath(root: string, path: string, limit = 10, git = gitIn(root)): CommitLite[] {
  try {
    const raw = git(['log', '--follow', `-n${limit}`, '--format=%h%x09%ad%x09%s', '--date=short', '--', path]);
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, at, ...rest] = line.split('\t');
        return { sha: sha ?? '', at: at ?? '', subject: rest.join('\t') };
      });
  } catch {
    return [];
  }
}

export interface RevertPlanEntry {
  path: string;
  /** 工作区有未提交改动（回退会覆盖它）。 */
  dirty: boolean;
  /** 目标 rev 里还有这个文件；没有就是"回退=删除"。 */
  existsInRev: boolean;
  added: number;
  removed: number;
}

export interface RevertPlan {
  rev: string;
  entries: RevertPlanEntry[];
  /** 阻断项：非空就不许执行（除非 allowDirty）。 */
  blockers: string[];
  allowDirty: boolean;
  planHash: string;
}

function hashPlan(plan: Omit<RevertPlan, 'planHash'>): string {
  return createHash('sha1').update(JSON.stringify(plan)).digest('hex').slice(0, 16);
}

/**
 * 第一步：出计划。**这一步绝不改任何文件**。
 *
 * 脏文件默认进 blockers —— 这是"误伤用户未提交改动"的唯一一道硬闸。
 */
export function planRevert(
  root: string,
  opts: { rev: string; paths: string[]; allowDirty?: boolean },
  git = gitIn(root),
): RevertPlan {
  const st = new Map(status(root, git).map((s) => [s.path, s]));
  const stats = new Map(numStat(root, opts.rev, opts.paths, git).map((s) => [s.path, s]));
  const entries: RevertPlanEntry[] = [];
  const blockers: string[] = [];

  for (const path of opts.paths) {
    const norm = path.replace(/\\/g, '/');
    const existsInRev = show(root, opts.rev, norm, git) !== null;
    const stat = stats.get(norm);
    const dirty = st.has(norm);
    entries.push({ path: norm, dirty, existsInRev, added: stat?.added ?? 0, removed: stat?.removed ?? -1 });
    if (dirty && !opts.allowDirty) blockers.push(`${norm}：工作区有未提交改动，回退会覆盖它`);
    /* 回退到"文件不存在"的 rev 等于删除它 —— 无条件阻断，要删得走别的路径。 */
    if (!existsInRev) blockers.push(`${norm}：目标 rev 里没有这个文件，回退等同于删除`);
  }

  const bare = { rev: opts.rev, entries, blockers, allowDirty: !!opts.allowDirty };
  return { ...bare, planHash: hashPlan(bare) };
}

function ticketsDir(root: string): string {
  return join(mapDir(root), 'tickets');
}

/** 第二步：确认票据。执行时必须带回来，且只对**同一份计划**有效。 */
export function createTicket(root: string, plan: RevertPlan, now = new Date().toISOString()): string {
  if (plan.blockers.length) throw new Error(`计划有阻断项，不许出票：${plan.blockers.join('；')}`);
  mkdirSync(ticketsDir(root), { recursive: true });
  const token = createHash('sha1').update(`${plan.planHash}:${now}`).digest('hex').slice(0, 12);
  writeFileSync(join(ticketsDir(root), `${token}.json`), JSON.stringify({ plan, at: now, used: false }, null, 2));
  return token;
}

/** 第三步：快照。动手前把当前内容原样存下来（文件不存在也记一笔）。 */
export function snapshot(root: string, paths: string[], now = new Date().toISOString()): string {
  const id = now.replace(/[:.]/g, '-');
  const dir = join(mapDir(root), 'snapshots', id);
  mkdirSync(dir, { recursive: true });
  const manifest: Array<{ path: string; existed: boolean; bytes?: number; sha1?: string }> = [];
  for (const path of paths) {
    const abs = join(root, path);
    if (!existsSync(abs)) {
      manifest.push({ path, existed: false });
      continue;
    }
    const content = readFileSync(abs);
    manifest.push({ path, existed: true, bytes: content.length, sha1: createHash('sha1').update(content).digest('hex') });
    const safe = path.replace(/[\\/]/g, '__');
    mkdirSync(dirname(join(dir, safe)), { recursive: true });
    writeFileSync(join(dir, safe), content);
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, at: now, manifest }, null, 2));
  return id;
}

export interface RevertResult {
  snapshotId: string;
  restored: string[];
  deleted: string[];
}

/**
 * 第四步：执行。
 *
 * 顺序是硬性的：**验票 → 验哈希 → 拍快照 → 才动工作区**。
 * 任何一步不合就抛错，且此时文件系统还没被碰过。
 */
export function executeRevert(
  root: string,
  plan: RevertPlan,
  token: string,
  opts: { now?: string; git?: (args: string[]) => string } = {},
): RevertResult {
  const file = join(ticketsDir(root), `${token}.json`);
  if (!existsSync(file)) throw new Error('没有这张票据（先 createTicket）');
  const ticket = JSON.parse(readFileSync(file, 'utf8')) as { plan: RevertPlan; used: boolean };
  if (ticket.used) throw new Error('票据已用过（一次一票）');
  /*
   * 重新计算而不是只比字段：只比 plan.planHash 的话，改 rev 而不改哈希就能绕过 ——
   * 那正好是"计划在出票后被改过"这件事本身。
   */
  const { planHash: _ignored, ...bare } = plan;
  const recomputed = hashPlan(bare);
  if (ticket.plan.planHash !== recomputed || plan.planHash !== recomputed) {
    throw new Error('计划与票据不一致（计划在出票后被改过）');
  }
  if (plan.blockers.length) throw new Error(`计划有阻断项：${plan.blockers.join('；')}`);

  const snapshotId = snapshot(root, plan.entries.map((e) => e.path), opts.now);
  const git = opts.git ?? gitIn(root);
  const restored: string[] = [];
  const deleted: string[] = [];
  for (const entry of plan.entries) {
    if (entry.existsInRev) {
      git(['restore', `--source=${plan.rev}`, '--worktree', '--', entry.path]);
      restored.push(entry.path);
    } else {
      const abs = join(root, entry.path);
      if (existsSync(abs)) unlinkSync(abs);
      deleted.push(entry.path);
    }
  }
  ticket.used = true;
  writeFileSync(file, JSON.stringify(ticket, null, 2));
  return { snapshotId, restored, deleted };
}
