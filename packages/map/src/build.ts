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
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MapIndex, MapNode, MapShard } from '@she/shared';
import { MAP_SCHEMA_VERSION } from '@she/shared';
import { emptyShard, readShard, shardKeyFor, shardPath, writeJsonAtomic, indexPath } from './store.js';
import { detectViews } from './views.js';
import { deriveGroups } from './groups.js';

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
  const branch = opts.branch ?? exec(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
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
      const byPath = new Map(prev.nodes.map((n) => [n.path, n]));
      for (const node of shard.nodes) {
        const old = byPath.get(node.path);
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
      shard.edges = prev.edges ?? [];
    }
    noteCount += shard.notes.length;
    edgeCount += shard.edges.length;
    writeJsonAtomic(shardPath(root, key), shard);
  }

  const index: MapIndex = {
    schemaVersion: MAP_SCHEMA_VERSION,
    root,
    branch,
    branches: [branch],
    shards: [...shards.values()].map((s) => ({
      key: s.key,
      paths: s.nodes.length,
      nodes: s.nodes.length,
      mtime: now,
    })),
    counts: {
      files: files.length,
      dirs: [...shards.values()].reduce((n, s) => n + s.nodes.filter((x) => x.kind === 'dir').length, 0),
      symbols: 0,
      edges: edgeCount,
      notes: noteCount,
    },
    views,
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
