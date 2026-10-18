/*
 * 收编（adopt）：**引用优先 + 写时复制**。
 *
 * 用户的原话："复制会导致吞噬大量 C 盘……设计修改再复制修改的，然后把别的串起来，
 * 不涉及修改的就一直用原文（孬好省点）"。
 *
 * 所以这里不搬数据：
 *  - 收编只写一条 **引用**（外部根 + 分片 + 路径 + 当时的 sha1），标签/注记正文留在外部；
 *  - 读的时候回外部取（`resolveRef`），并且按**本地内容 sha** 判新鲜度：不一致就标"外部那一版"；
 *  - 只有真的要**改**某条时（annotate 命中已有引用）才把它复制成本地实体，并记 `derivedFrom`。
 *
 * 三条不可退让的语义：
 *  ① 引用来的东西**永远带出处**，不许当本地事实；
 *  ② 外部不可达时显示"外部不可用"，**不许静默消失**（静默消失 = 错误空白）；
 *  ③ 外部只读：本地 `.she/map` 仍是唯一可写目标。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { MapNode } from '@she/shared';
import { emptyShard, readIndex, readShard, shardKeyFor, shardPath, writeJsonAtomic, mapDir } from './store.js';

export interface MapRef {
  /** 本地路径（已按 prefix 映射过）。 */
  path: string;
  branch: string;
  /** 外部工作区根（绝对路径）。 */
  from: string;
  /** 外部那条节点所在的分片键。 */
  shard: string;
  /** 收编时外部节点的内容 sha，用来判新鲜度。 */
  sha1?: string;
  at: string;
}

type ShardWithRefs = { key: string; branch: string; nodes: MapNode[]; edges: unknown[]; notes: unknown[]; refs?: MapRef[] };

function shardWithRefs(root: string, branch: string, path: string): ShardWithRefs {
  const key = shardKeyFor(path);
  const shard = (readShard(root, key) as ShardWithRefs | null) ?? (emptyShard(key, branch) as ShardWithRefs);
  if (!shard.refs) shard.refs = [];
  return shard;
}

export function refsOf(root: string, branch: string, path: string): MapRef[] {
  const shard = readShard(root, shardKeyFor(path)) as ShardWithRefs | null;
  return (shard?.refs ?? []).filter((r) => r.path === path && r.branch === branch);
}

export interface AdoptResult {
  adopted: number;
  /** 路径在本地不存在、又没给映射的条目：如实列出来，不猜。 */
  unmatched: string[];
  /** 外部有内容、但外部根读不到的条目。 */
  unreadable: number;
}

/**
 * 收编：只写引用，不搬正文。
 *
 * `prefix` 形如 `{ 'old/src': 'new/src' }`，用于两个工作区目录结构不同时显式对齐。
 * 对不上就进 unmatched，**绝不按文件名猜**（猜错等于往地图里灌假事实）。
 */
export function adoptFrom(
  root: string,
  branch: string,
  externalRoot: string,
  opts: { prefix?: Record<string, string>; now?: string; localPaths?: Set<string> } = {},
): AdoptResult {
  const now = opts.now ?? new Date().toISOString();
  const index = readIndex(externalRoot);
  if (!index) throw new Error(`外部工作区没有地图：${externalRoot}`);
  const refs: MapRef[] = [];
  const unmatched: string[] = [];
  let unreadable = 0;

  for (const s of index.shards) {
    let shard: ShardWithRefs | null = null;
    try {
      shard = readShard(externalRoot, s.key) as ShardWithRefs | null;
    } catch {
      unreadable += 1;
      continue;
    }
    if (!shard) continue;
    for (const node of shard.nodes) {
      if (node.kind !== 'file') continue;
      if (!node.label && !node.what && !node.when) continue; // 没内容就没必要收编
      const mapped = applyPrefix(node.path, opts.prefix);
      if (opts.localPaths && !opts.localPaths.has(mapped)) {
        unmatched.push(mapped);
        continue;
      }
      refs.push({ path: mapped, branch, from: externalRoot, shard: s.key, sha1: node.sha1, at: now });
    }
  }

  /* 按本地分片归并后落盘：引用本身很小，几十字节一条。 */
  const byShard = new Map<string, ShardWithRefs>();
  for (const ref of refs) {
    const key = shardKeyFor(ref.path);
    let shard = byShard.get(key);
    if (!shard) {
      shard = shardWithRefs(root, branch, ref.path);
      byShard.set(key, shard);
    }
    shard.refs!.push(ref);
  }
  for (const [key, shard] of byShard) writeJsonAtomic(shardPath(root, key), shard);

  return { adopted: refs.length, unmatched, unreadable };
}

function applyPrefix(path: string, prefix?: Record<string, string>): string {
  if (!prefix) return path;
  for (const [from, to] of Object.entries(prefix)) {
    if (path === from) return to;
    if (path.startsWith(from + '/')) return posix.join(to, path.slice(from.length + 1));
  }
  return path;
}

export interface ExternalHit {
  node: MapNode;
  ref: MapRef;
  /** 外部那一版与本地内容是否一致。 */
  fresh: boolean;
  /** 外部根读不到时的说明（此时 node 为空）。 */
  unavailable?: string;
}

/**
 * 解析一条引用：回外部把标签取回来，并按本地 sha 判新鲜度。
 * 外部根不存在／分片坏 → 返回 unavailable，让调用方把"外部不可用"显示出来。
 */
export function resolveRef(ref: MapRef, localSha1?: string): ExternalHit | { unavailable: string } {
  if (!existsSync(mapDir(ref.from))) return { unavailable: `外部工作区没有地图：${ref.from}` };
  let shard: ShardWithRefs | null = null;
  try {
    shard = readShard(ref.from, ref.shard) as ShardWithRefs | null;
  } catch {
    return { unavailable: `外部分片读不出来：${join(mapDir(ref.from), `shard-${ref.shard}.json`)}` };
  }
  const node = shard?.nodes.find((n) => n.path === ref.path && n.kind === 'file');
  if (!node) return { unavailable: `外部地图里已经没有这个条目：${ref.path}` };
  const fresh = !ref.sha1 || !localSha1 || ref.sha1 === localSha1;
  return { node, ref, fresh };
}

/** 把一条引用"落地"成本地实体：写时复制时才调用。 */
export function materialize(
  root: string,
  branch: string,
  path: string,
  source: MapNode,
  from: string,
  now = new Date().toISOString(),
): MapNode {
  const shard = shardWithRefs(root, branch, path);
  let node = shard.nodes.find((n) => n.branch === branch && n.path === path);
  if (!node) {
    node = { kind: 'file', branch, path };
    shard.nodes.push(node);
  }
  node.label = source.label;
  node.what = source.what;
  node.when = source.when;
  node.labelSha1 = source.sha1;
  node.lastSeen = now;
  shard.refs = shard.refs!.filter((r) => !(r.path === path && r.branch === branch));
  writeJsonAtomic(shardPath(root, shardKeyFor(path)), shard);
  return node;
}
