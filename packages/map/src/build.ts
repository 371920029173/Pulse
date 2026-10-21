/*
 * 建图：一次 `git ls-files -s -z` 拿到全仓 path + blob sha。
 *
 * 为什么不用 fs 递归遍历：
 *  - git 已经知道哪些文件属于仓库（.gitignore 免费到手），自己再实现一遍必然跑偏；
 *  - 一次进程就能拿到 10 万条 path+sha，I/O 只发生一次（fs walk 是 10 万次 stat）；
 *  - sha 是内容身份，正是标签新鲜度要绑的东西，不用再自己算（自己算还要处理 filters/CRLF）。
 *
 * 排除：`dist/` `node_modules/` 这类构建产物、二进制、超大文件、以及 `.env`/密钥 ——
 * 后者的排除是硬规则，和 KB 的禁忌一致：地图绝不索引凭据。
 */
import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { MapIndex, MapNode, MapShard } from '@she/shared';
import { MAP_SCHEMA_VERSION } from '@she/shared';
import { emptyShard, mapDir, readIndex, readShard, shardKeyFor, shardPath, writeJsonAtomic, indexPath } from './store.js';
import { detectViews } from './views.js';
import { deriveGroups } from './groups.js';
import { buildSymbols, writeSymbols } from './symbols.js';
import { scanImports } from './imports.js';
import { scanHttpContracts } from './contracts.js';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** 构建产物/依赖目录：不是"作者写的代码"，读它等于读生成物。 */
const EXCLUDE_DIR = /(^|\/)(node_modules|dist|build|out|coverage|\.git|\.she|vendor|target)(\/|$)/;

/** 凭据类文件：永不索引（与 KB 禁忌一致）。 */
const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|pfx|p12|crt)|id_rsa|id_ed25519|credentials(\.json)?|\.npmrc|\.pypirc)$/i;

/** 生成物标记：读它是白读，改它会被覆盖。 */
const GENERATED = /(^|\/)(.*\.(pb|gen|g)\.(ts|js|go|py)|.*_generated\.\w+|.*\.min\.(js|css))$/i;

const LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  md: 'md', json: 'json', css: 'css', scss: 'scss', html: 'html',
  py: 'py', go: 'go', rs: 'rs', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  java: 'java', kt: 'kt', cs: 'cs', rb: 'rb', php: 'php', sql: 'sql',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', sh: 'sh', ps1: 'ps1', proto: 'proto',
};

export interface BuildOptions {
  root: string;
  /** 收集时的分支名（地图默认视图）。 */
  branch?: string;
  /** 只建某个子树（渐进式接入：先标一个子系统就能用）。 */
  scope?: string;
  /** 注入的 git 执行器，测试里换成假的。 */
  exec?: (args: string[]) => string;
}

export interface BuildResult {
  index: MapIndex;
  shards: number;
  files: number;
  dirs: number;
  skipped: { excluded: number; secret: number; binary: number; large: number };
}

function realExec(root: string) {
  return (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

/** 二进制探测：前 8KB 里出现 NUL 就当二进制（git 自己也是这么判的）。 */
function looksBinary(abs: string): boolean {
  try {
    const buf = readFileSync(abs);
    const n = Math.min(buf.length, 8192);
    for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
    return false;
  } catch {
    return true;
  }
}

function langOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return LANG[ext] ?? (path.includes('.') ? 'other' : 'none');
}

/** 目录节点：路径去重后全量补上，地图的骨架要完整，否则"往上看"会断。 */
function dirsOf(paths: string[]): string[] {
  const set = new Set<string>();
  for (const p of paths) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i += 1) set.add(segs.slice(0, i).join('/'));
  }
  return [...set].sort();
}

export function buildMap(opts: BuildOptions): BuildResult {
  const { root } = opts;
  const exec = opts.exec ?? realExec(root);
  let branch: string;
  try {
    branch = opts.branch ?? exec(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch {
    throw new Error(`这不是一个 git 仓库（${root}）：地图靠 git 拿文件清单与内容 sha，请先 git init，或换到仓库根再跑`);
  }
  const rev = exec(['rev-parse', '--short', 'HEAD']).trim();
  const now = new Date().toISOString();

  const args = ['ls-files', '-s', '-z'];
  if (opts.scope) args.push('--', opts.scope);
  const raw = exec(args);

  const views = detectViews(root);
  const skipped = { excluded: 0, secret: 0, binary: 0, large: 0 };
  const files: MapNode[] = [];

  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const meta = entry.slice(0, tab);
    const path = entry.slice(tab + 1).replace(/\\/g, '/');
    const m = meta.match(/^\d+ ([0-9a-f]{40}) \d+$/);
    if (!m) continue;
    const sha1 = m[1]!;

    if (EXCLUDE_DIR.test(path)) { skipped.excluded += 1; continue; }
    if (SECRET.test(path)) { skipped.secret += 1; continue; }

    let size = 0;
    try {
      size = statSync(join(root, path)).size;
    } catch {
      skipped.excluded += 1;
      continue;
    }
    if (size > MAX_FILE_BYTES) { skipped.large += 1; continue; }
    if (looksBinary(join(root, path))) { skipped.binary += 1; continue; }

    files.push({
      kind: 'file',
      branch,
      path,
      sha1,
      rev,
      lang: langOf(path),
      size,
      groups: deriveGroups(path, views),
      generated: GENERATED.test(path) || undefined,
      lastSeen: now,
    });
  }

  /*
   * import 边在分片之前算：inDegree 要写回文件节点（"被多少人引用"是模型判断
   * 一个重要性的第一手信号），而节点是直接放进分片数组的同一批对象。
   */
  /*
   * 一次读取、三个抽取器共用。
   * 上限 256MB：超过就不缓存（宁可再读一遍，也不把内存吃穿）。
   */
  const textCache = new Map<string, string>();
  let cacheBytes = 0;
  const CACHE_LIMIT = 256 * 1024 * 1024;
  const readCached = (rel: string): string => {
    const hit = textCache.get(rel);
    if (hit !== undefined) return hit;
    const text = readFileSync(join(root, rel), 'utf8');
    if (cacheBytes + text.length <= CACHE_LIMIT) {
      textCache.set(rel, text);
      cacheBytes += text.length;
    }
    return text;
  };

  const { edges: importEdges, unresolved: wiringUnresolved } = scanImports(
    root,
    files.map((f) => ({ path: f.path, lang: f.lang })),
    views.packages.map((p) => ({ name: p.name, root: p.root })),
    readCached,
  );
  const inDegree = new Map<string, number>();
  for (const { edge } of importEdges) inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  for (const f of files) {
    const deg = inDegree.get(f.path);
    if (deg) f.inDegree = deg;
  }

  const shards = new Map<string, MapShard>();
  for (const node of files) {
    const key = shardKeyFor(node.path);
    if (!shards.has(key)) shards.set(key, emptyShard(key, branch));
    shards.get(key)!.nodes.push(node);
  }
  for (const dir of dirsOf(files.map((f) => f.path))) {
    const key = shardKeyFor(dir);
    if (!shards.has(key)) shards.set(key, emptyShard(key, branch));
    shards.get(key)!.nodes.push({ kind: 'dir', branch, path: dir, rev, lastSeen: now, groups: deriveGroups(dir, views) });
  }

  /*
   * 重建要**合并**而不是覆盖：上一轮写的 label / what / when / groups / notes 必须留住。
   * 只保留仍然存在的路径的标注；内容变了交给 labelIsStale 判过期（旧描述不删）。
   */
  let noteCount = 0;
  let edgeCount = 0;
  for (const [key, shard] of shards) {
    const prev = readShard(root, key);
    if (prev) {
      /*
       * 键必须是 branch:path —— 只按 path 的话，建第二条分支时新节点会继承主干那条的标签，
       * 两条分支的描述互相踩。
       */
      const byKey = new Map(prev.nodes.map((n) => [`${n.branch}:${n.path}`, n]));
      /* 其它分支的节点原样带过来：孪生体要活过每一次重建。 */
      const otherBranches = prev.nodes.filter((n) => n.branch !== branch);
      if (otherBranches.length) shard.nodes.push(...otherBranches);
      for (const node of shard.nodes) {
        const old = byKey.get(`${node.branch}:${node.path}`);
        if (!old) continue;
        if (old.label !== undefined) {
          node.label = old.label;
          node.labelSha1 = old.labelSha1;
        }
        if (old.what !== undefined) node.what = old.what;
        if (old.when !== undefined) node.when = old.when;
        if (old.groups) node.groups = [...new Set([...(node.groups ?? []), ...old.groups])];
        if (old.lastSeen) node.lastSeen = old.lastSeen;
      }
      shard.notes = prev.notes ?? [];
      /* 知识绑定是模型资产，也必须活过重建（否则每建一次图，组结构知识就全丢）。 */
      const prevLinks = (prev as unknown as { kbLinks?: unknown[] }).kbLinks;
      if (prevLinks?.length) (shard as unknown as { kbLinks?: unknown[] }).kbLinks = prevLinks;
      /*
       * 边不保留旧值：它完全由当前源码派生。保留的话，改掉的依赖会永远留在图上
       * （悬空边判据会一直红，而模型会照着错的图去判断影响面）。
       */
      shard.edges = [];
    }
    noteCount += shard.notes.length;
    edgeCount += shard.edges.length;
    writeJsonAtomic(shardPath(root, key), shard);
  }

  /*
   * 清理孤儿分片：换过分片键、或文件被删之后，旧 shard-*.json 会一直躺在磁盘上，
   * 被 check:map 数进去、被 verify 当成文件——看起来像"地图里有不存在的分片"。
   */
  try {
    const keep = new Set([...shards.keys()].map((k) => `shard-${k}.json`));
    for (const f of readdirSync(mapDir(root))) {
      if (f.startsWith('shard-') && f.endsWith('.json') && !keep.has(f)) unlinkSync(join(mapDir(root), f));
    }
  } catch {
    /* 清理失败不影响建图结果 */
  }

  /*
   * 符号表在分片之后建：它要读文件正文，跟分片的 path 列表对齐。
   * 一次全量扫在这个仓库是百毫秒级；10 万文件时它是最贵的一步（两遍读），
   * 所以将来要按 ROI 队列增量更新，而不是每次全建。
   */
  /*
   * 边必须在"保留旧 edges"的合并之后挂：合并那一步会用旧分片的 edges 覆盖当前值，
   * 先挂就白挂了（这类顺序错误不会报错，只会让影响面永远算空）。
   */
  const touchedShards = new Set<string>();
  for (const { from, edge } of importEdges) {
    const key = shardKeyFor(from);
    const shard = shards.get(key);
    if (!shard) continue;
    shard.edges.push(edge);
    touchedShards.add(key);
  }
  /*
   * 契约图：服务端注册的每条路由都是"创建时记录的潜在依赖"，与前端 fetch 对账后
   * 分成确定边与潜在威胁两类。威胁也是边（confidence=candidate），只是要带 falsifiers。
   */
  const contracts = scanHttpContracts(root, files.map((f) => ({ path: f.path })), readCached);
  for (const { from, edge } of contracts.edges) {
    const key = shardKeyFor(from);
    const shard = shards.get(key);
    if (!shard) continue;
    shard.edges.push(edge);
    touchedShards.add(key);
  }

  /* 见上：挂边发生在写盘之后，这里必须补一次落盘。 */
  for (const key of touchedShards) writeJsonAtomic(shardPath(root, key), shards.get(key)!);

  const symbolTable = buildSymbols({
    root,
    files: files.map((f) => ({ path: f.path, lang: f.lang })),
    readFile: readCached,
  });
  writeSymbols(root, symbolTable);

  const index: MapIndex = {
    schemaVersion: MAP_SCHEMA_VERSION,
    root,
    branch,
    /* 分支取并集：孪生分支不能因为重建一次就消失。 */
    branches: [...new Set([branch, ...(readIndex(root)?.branches ?? [])])],
    shards: [...shards.values()].map((s) => ({
      key: s.key,
      paths: s.nodes.length,
      nodes: s.nodes.length,
      mtime: now,
    })),
    counts: {
      files: files.length,
      dirs: [...shards.values()].reduce((n, s) => n + s.nodes.filter((x) => x.kind === 'dir').length, 0),
      symbols: symbolTable.names.length,
      edges: [...shards.values()].reduce((n, s) => n + s.edges.length, 0),
      notes: noteCount,
    },
    views,
    contractUnresolved: contracts.unresolved,
    wiringEdges: importEdges.filter((e) => e.edge.label).length,
    wiringUnresolved,
    topDirs: [...new Set(files.map((f) => (f.path.includes('/') ? f.path.slice(0, f.path.indexOf('/')) : '')).filter(Boolean))].sort(),
    excludes: { patterns: [EXCLUDE_DIR.source, SECRET.source], maxFileBytes: MAX_FILE_BYTES },
    updatedAt: now,
  };
  writeJsonAtomic(indexPath(root), index);

  return { index, shards: shards.size, files: files.length, dirs: index.counts.dirs, skipped };
}

/** 地图是否已经建过（P1 之后，工具用这个决定是提示"还没建图"还是直接查）。 */
export function hasMap(root: string): boolean {
  try {
    return statSync(indexPath(root)).isFile();
  } catch {
    return false;
  }
}

/** 便于人工排查：把根分片的人类可读摘要打出来（不是给模型用的接口）。 */
export function describe(root: string): string {
  const index = JSON.parse(readFileSync(indexPath(root), 'utf8')) as MapIndex;
  const top = index.shards
    .slice()
    .sort((a, b) => b.paths - a.paths)
    .slice(0, 12)
    .map((s) => `${s.key}(${s.paths})`)
    .join(' ');
  return `${index.branch}@${index.updatedAt} 文件 ${index.counts.files} 目录 ${index.counts.dirs} 分片 ${index.shards.length}｜最大分片: ${top}`;
}
