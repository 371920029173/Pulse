/*
 * 组结构 ↔ 地图的绑定，以及"知识向上冒泡"。
 *
 * 这是这套地图和所有开源 code-graph MCP 的分界线：它们只有"文件"一个维度，
 * 我们把 KB 的组结构挂到地图节点上，并且允许一条知识挂在**目录**上 ——
 * 查一个文件时，挂在它祖先目录上的知识会一起浮上来（标 `fromAncestor`），
 * 因为很多知识本来就不是"某个文件的"，而是"这个子系统的"。
 *
 * 两种强度：
 *   certain   —— 显式绑定（模型/工具明确写了"这条知识对应这个路径/组"）
 *   candidate —— 字面命中（知识正文里出现了这个路径），只是线索，必须带证据
 * 与 KB 的边类型纪律一致：候选永不假装成确定。
 */
import { readShard, writeJsonAtomic, shardPath, shardKeyFor } from './store.js';
import { ancestorDirs, groupContains } from './groups.js';
import type { MapConfidence } from '@she/shared';

export interface MapKbLink {
  /** 地图节点路径（文件或目录）。 */
  path: string;
  /** KB 组路径，例如 `architecture/ui`。 */
  kbGroup: string;
  /** KB 节点 id（可空：只绑组不绑具体记忆）。 */
  kbNodeId?: string;
  /** 让人一眼知道这条知识讲什么（标题，不是正文）。 */
  title: string;
  confidence: MapConfidence;
  /** certain 也要证据：谁、什么时候、因为什么挂上去的。 */
  evidence: string[];
  falsifiers?: string[];
  at: string;
}

export interface BoundKbLink extends MapKbLink {
  /** 命中的是祖先目录，而不是文件本身。 */
  fromAncestor: boolean;
  /** 实际命中的路径（文件时等于 path；祖先时是那个目录）。 */
  via: string;
}

function shardOf(root: string, branch: string, path: string) {
  const key = shardKeyFor(path);
  return { key, shard: readShard(root, key) ?? { key, branch, nodes: [], edges: [], notes: [] } };
}

/**
 * 绑定一条知识到一个路径。
 *
 * `candidate` 必须带 falsifiers —— 与边的纪律一样：说不出"什么情况下这条绑定不成立"，
 * 就不许把它标成候选，更不许标成确定。
 */
export function linkKb(
  root: string,
  branch: string,
  link: Omit<MapKbLink, 'at'> & { at?: string },
  now = new Date().toISOString(),
): MapKbLink {
  if (link.confidence === 'candidate' && (!link.evidence.length || !(link.falsifiers?.length))) {
    throw new Error('candidate 绑定必须同时提供 evidence 与 falsifiers');
  }
  const { key, shard } = shardOf(root, branch, link.path);
  const full: MapKbLink = { ...link, at: link.at ?? now };
  const shardAny = shard as typeof shard & { kbLinks?: MapKbLink[] };
  shardAny.kbLinks = [...(shardAny.kbLinks ?? []).filter((l) => !(l.path === full.path && l.kbGroup === full.kbGroup && l.kbNodeId === full.kbNodeId)), full];
  writeJsonAtomic(shardPath(root, key), shardAny);
  return full;
}

/**
 * 查一个路径相关的知识：先文件本身，再逐级祖先目录冒泡。
 *
 * 祖先命中的一律标 `fromAncestor: true` 并把 `via` 指到那个目录 —— 模型能立刻看出
 * "这条讲的是整个 `packages/ui`，不是这个组件"，避免把子系统级结论套到单个文件上。
 */
export function kbLinksFor(root: string, branch: string, path: string, opts: { includeAncestors?: boolean } = {}): BoundKbLink[] {
  const includeAncestors = opts.includeAncestors !== false;
  const out: BoundKbLink[] = [];
  const seen = new Set<string>();

  const collect = (at: string, fromAncestor: boolean) => {
    const { shard } = shardOf(root, branch, at);
    const links = ((shard as unknown as { kbLinks?: MapKbLink[] }).kbLinks ?? []).filter((l) => l.path === at);
    for (const l of links) {
      const id = `${l.kbGroup}:${l.kbNodeId ?? ''}:${l.title}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ ...l, fromAncestor, via: at });
    }
  };

  collect(path, false);
  if (includeAncestors) {
    for (const dir of ancestorDirs(path)) {
      if (dir === path) continue;
      collect(dir, true);
    }
  }

  /** 确定性优先：确定在前，然后按"离得近的祖先"在前。 */
  return out.sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'certain' ? -1 : 1;
    if (a.fromAncestor !== b.fromAncestor) return a.fromAncestor ? 1 : -1;
    return a.via.length - b.via.length;
  });
}

/** 某个组下绑定了哪些知识（功能轴用得多：一个功能组横跨多个文件）。 */
export function kbLinksInGroup(root: string, branch: string, group: string): BoundKbLink[] {
  const out: BoundKbLink[] = [];
  const index = readShard(root, shardKeyFor(group.replace(/^[a-z]+:/, '')));
  if (!index) return out;
  for (const l of ((index as unknown as { kbLinks?: MapKbLink[] }).kbLinks ?? [])) {
    if (groupContains(group, `dir:${l.path}`)) out.push({ ...l, fromAncestor: false, via: l.path });
    else if (`dir:${l.path}` === group) out.push({ ...l, fromAncestor: false, via: l.path });
  }
  return out;
}
