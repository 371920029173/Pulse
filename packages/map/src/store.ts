/*
 * 地图存储：分片读写 + 标签的新鲜度判定。
 *
 * 为什么不是一个 map.json：100k 文件下"加载整张图"本身就是 O(仓)，而模型一次只看一个视野。
 * 分片让孩子树、热更新、并发写（不同分片）三件事同时成立。
 *
 * 为什么写盘用 tmp + rename：`writeFileSync` 直接覆盖一个正在被另一窗口读的文件，
 * 读到的是半个 JSON —— 于是整张图被判为损坏。rename 在同一文件系统上是原子的。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { MapIndex, MapNode, MapNote, MapShard, MapEdge } from '@she/shared';

export const MAP_DIR = '.she/map';
export const INDEX_FILE = 'index.json';

export function mapDir(root: string): string {
  return join(root, MAP_DIR);
}

export function indexPath(root: string): string {
  return join(mapDir(root), INDEX_FILE);
}

export function shardPath(root: string, key: string): string {
  return join(mapDir(root), `shard-${key}.json`);
}

/**
 * 分片键 = 顶层路径段。顶层散文件归到 `_root`。
 *
 * 用名字而不是序号：人肉排查时 `shard-packages.json` 一眼知道是哪块，`shard-07.json` 不行。
 * 非法文件名字符换成下划线（Windows 上 `:` `?` 都不能进文件名）。
 */
export function shardKeyFor(path: string): string {
  const seg = path.includes('/') ? path.slice(0, path.indexOf('/')) : '_root';
  return seg.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || '_root';
}

/** 原子写：同目录 tmp → rename。 */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* tmp 删不掉不影响结论 */
    }
    throw err;
  }
}

export function readIndex(root: string): MapIndex | null {
  const p = indexPath(root);
  if (!existsSync(p)) return null;
  /*
   * 坏 index.json 原来会让**每条命令**抛 SyntaxError（分片有 readShardSafe，index 没有）。
   * 这里当成"没有地图"返回 null，由调用方统一说"先跑 map:build"，而不是把栈抛给用户。
   */
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as MapIndex;
  } catch {
    return null;
  }
}

export function readShard(root: string, key: string): MapShard | null {
  const p = shardPath(root, key);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as MapShard;
}

/** 读到一半的 JSON 别把整张图拖垮：坏分片当成不存在，由调用方决定报错还是跳过。 */
export function readShardSafe(root: string, key: string): { shard: MapShard | null; broken: boolean } {
  try {
    return { shard: readShard(root, key), broken: false };
  } catch {
    return { shard: null, broken: true };
  }
}

export function emptyShard(key: string, branch: string): MapShard {
  return { key, branch, nodes: [], edges: [], notes: [] };
}

/**
 * 标签是否过期。
 *
 * 判定标准是**内容身份**（`labelSha1` vs 当前 `sha1`），不是时间戳：改一下时间不改内容不该让
 * 标签失效，而 amend / rebase 之后内容变了必须失效。过期的标签**不删** —— 它描述的那一版
 * 仍然值得留着（"之前什么样"），只是不能被当成现在的结论。
 */
export function labelIsStale(node: MapNode): boolean {
  if (!node.label) return false;
  return !!node.labelSha1 && !!node.sha1 && node.labelSha1 !== node.sha1;
}

/** 当前内容的 sha1：直接问 git，不自己算（自己算就要处理 filters/CRLF，会算错）。 */
export function sha1Of(root: string, path: string, git: (args: string[]) => string): string | null {
  try {
    const out = git(['ls-files', '-s', '-z', '--', path]);
    const entry = out.split('\0').find(Boolean);
    if (!entry) return null;
    const m = entry.match(/^\d+ ([0-9a-f]{40}) \d\t/);
    return m ? m[1]! : null;
  } catch {
    return null;
  }
}

export interface AnnotateInput {
  path: string;
  label?: string;
  what?: string;
  when?: string;
  groups?: string[];
}

export interface AnnotateResult {
  node: MapNode;
  staleBefore: boolean;
}

/**
 * 顺手命名：模型干活时给文件写一段"是什么 / 干什么 / 什么时候该读"。
 *
 * 写入时记下 `labelSha1`——标签绑定**当时看到的内容**。之后内容一变，读出来就是 stale，
 * 而不是悄悄把旧描述当成新事实。
 */
export function annotate(
  root: string,
  branch: string,
  input: AnnotateInput,
  git: (args: string[]) => string,
  now = new Date().toISOString(),
): AnnotateResult {
  const key = shardKeyFor(input.path);
  const shard = readShard(root, key) ?? emptyShard(key, branch);
  let node = shard.nodes.find((n) => n.branch === branch && n.path === input.path);
  if (!node) {
    node = { kind: 'file', branch, path: input.path };
    shard.nodes.push(node);
  }
  const staleBefore = labelIsStale(node);
  const sha = sha1Of(root, input.path, git) ?? node.sha1;
  if (sha) node.sha1 = sha;
  if (input.label !== undefined) node.label = [...input.label].slice(0, 16).join('');
  if (input.what !== undefined) node.what = input.what;
  if (input.when !== undefined) node.when = input.when;
  if (input.groups !== undefined) node.groups = [...new Set([...(node.groups ?? []), ...input.groups])];
  node.labelSha1 = node.sha1;
  node.stale = false;
  node.lastSeen = now;
  writeJsonAtomic(shardPath(root, key), shard);
  return { node, staleBefore };
}

export function addNote(root: string, branch: string, note: Omit<MapNote, 'id' | 'at'> & { at?: string }): MapNote {
  const key = shardKeyFor(note.path);
  const shard = readShard(root, key) ?? emptyShard(key, branch);
  const id = createHash('sha1').update(`${branch}:${note.path}:${note.kind}:${note.text}:${Date.now()}`).digest('hex').slice(0, 12);
  const full: MapNote = { ...note, id, at: note.at ?? new Date().toISOString() };
  shard.notes.push(full);
  writeJsonAtomic(shardPath(root, key), shard);
  return full;
}

export function addEdges(root: string, branch: string, path: string, edges: MapEdge[]): void {
  if (!edges.length) return;
  const key = shardKeyFor(path);
  const shard = readShard(root, key) ?? emptyShard(key, branch);
  shard.edges.push(...edges);
  writeJsonAtomic(shardPath(root, key), shard);
}
