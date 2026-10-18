/*
 * 查询面：模型真正会调用的六个函数。
 *
 * 全部围绕一条纪律：**先说不知道，再说知道**。任何一条结果如果绑定的内容已经过期，
 * 就明确写"这描述的是 N 个提交前的内容"，而不是把旧标签当新事实。
 *
 * token 预算是硬的：超预算时先塌缩**最不活跃**的子树（脏 / 热 / 有注记的永不塌缩），
 * 而不是把一坨塞进上下文让模型自己挑。
 */
import { readIndex, readShard, readShardSafe, addNote, sha1Of, labelIsStale } from './store.js';
import { kbLinksFor, type BoundKbLink } from './bind.js';
import { refsOf, resolveRef } from './adopt.js';
import { deriveGroups } from './groups.js';
import { readSymbols, symbolsInFile } from './symbols.js';
import { logForPath, numStat, gitIn, status } from './gitlayer.js';
import { gateFor, type GateHit } from './gate.js';
import type { MapIndex, MapNote, MapNode, MapEdge } from '@she/shared';

export const estimateTokens = (text: string): number => Math.ceil(text.length / 3);

interface Loaded {
  index: MapIndex | null;
  nodes: MapNode[];
  edges: MapEdge[];
  notes: MapNote[];
  /** 读不出来的分片数量（地图可信度的一部分）。 */
  brokenShards: number;
}

export function loadAll(root: string): Loaded {
  const index = readIndex(root);
  if (!index) return { index: null, nodes: [], edges: [], notes: [], brokenShards: 0 };
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const notes: MapNote[] = [];
  let brokenShards = 0;
  for (const s of index.shards) {
    const { shard, broken } = readShardSafe(root, s.key);
    if (broken) {
      brokenShards += 1;
      continue;
    }
    if (!shard) continue;
    nodes.push(...shard.nodes);
    edges.push(...shard.edges);
    notes.push(...shard.notes);
  }
  return { index, nodes, edges, notes, brokenShards };
}

function nodeFor(loaded: Loaded, branch: string, path: string): MapNode | undefined {
  return loaded.nodes.find((n) => n.branch === branch && n.path === path);
}

// ── map_tree ────────────────────────────────────────────────────────────────

export interface TreeOptions {
  depth?: number;
  budgetTokens?: number;
  branch?: string;
}

export interface TreeResult {
  text: string;
  tokens: number;
  /** 因为预算被折叠掉的目录数。 */
  collapsed: number;
  files: number;
}

interface TreeDir {
  path: string;
  files: MapNode[];
  dirs: Map<string, TreeDir>;
}

function buildDirTree(nodes: MapNode[]): TreeDir {
  const root: TreeDir = { path: '.', files: [], dirs: new Map() };
  for (const node of nodes) {
    if (node.kind !== 'file') continue;
    const segs = node.path.split('/');
    let cur = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const name = segs[i]!;
      let next = cur.dirs.get(name);
      if (!next) {
        next = { path: segs.slice(0, i + 1).join('/'), files: [], dirs: new Map() };
        cur.dirs.set(name, next);
      }
      cur = next;
    }
    cur.files.push(node);
  }
  return root;
}

/** 活跃度：脏 / 热 / 有注记 / 有标签的目录塌不得——那些正是模型最可能要看的地方。 */
function activity(dir: TreeDir): number {
  let score = dir.files.reduce((n, f) => n + (f.label ? 2 : 0) + (f.inDegree ?? 0), 0);
  for (const sub of dir.dirs.values()) score += activity(sub);
  return score;
}

function countFiles(dir: TreeDir): number {
  let n = dir.files.length;
  for (const sub of dir.dirs.values()) n += countFiles(sub);
  return n;
}

function render(dir: TreeDir, opts: { depth: number; level: number; collapsed: Set<string>; notesByPath: Map<string, number> }): string[] {
  const out: string[] = [];
  const pad = '  '.repeat(opts.level);
  for (const [name, sub] of [...dir.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    /* 折叠的目录不出行：每折一个留一行的话，60 个冷目录照样压不下预算。汇总在末尾给一行。 */
    if (opts.collapsed.has(sub.path)) continue;
    const label = sub.files.length === 0 && sub.dirs.size === 0 ? '' : '';
    out.push(`${pad}${name}/${label}`);
    if (opts.level + 1 < opts.depth) out.push(...render(sub, { ...opts, level: opts.level + 1 }));
  }
  for (const f of [...dir.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const stale = labelIsStale(f) ? ' ~过期' : '';
    const notes = opts.notesByPath.get(f.path) ?? 0;
    const noteMark = notes ? ` [注记 ${notes}]` : '';
    const refs = f.inDegree ? ` (引用 ${f.inDegree})` : '';
    out.push(`${pad}${f.path.split('/').pop()}  ${f.label ?? '(未标注)'}${refs}${stale}${noteMark}`);
  }
  return out;
}

/**
 * 一眼看到底：整棵树 + 每个文件一行标签。
 *
 * 超预算时按活跃度从小到大折叠目录——**冷的最先被折**，热的有标签的最后才动。
 */
export function mapTree(root: string, opts: TreeOptions = {}): TreeResult {
  const loaded = loadAll(root);
  if (!loaded.index) return { text: '(还没有地图：先跑 pnpm map:build)', tokens: 0, collapsed: 0, files: 0 };
  const branch = opts.branch ?? loaded.index.branch;
  const depth = opts.depth ?? 6;
  const budget = opts.budgetTokens ?? 2000;

  const notesByPath = new Map<string, number>();
  for (const n of loaded.notes) notesByPath.set(n.path, (notesByPath.get(n.path) ?? 0) + 1);

  const tree = buildDirTree(loaded.nodes.filter((n) => n.branch === branch));
  const collapsed = new Set<string>();
  const renderNow = () => {
    const lines = render(tree, { depth, level: 0, collapsed, notesByPath });
    /*
     * 折叠文件数 = 总数 − 实际渲染数。之前是"每折一个目录就把它的子树文件数累加一遍"，
     * 嵌套目录被重复计数，于是出现"折叠 877 个文件 > 全仓 539 个"这种自相矛盾的数字。
     * 总数 − 渲染数 天然把 depth 截断也算进去，不会超。
     */
    const rendered = lines.filter((l) => !l.trimEnd().endsWith('/') && !l.includes('已折叠')).length;
    const hidden = Math.max(0, (loaded.index!.counts.files ?? 0) - rendered);
    if (collapsed.size || hidden > 0) {
      lines.push(`… 已折叠 ${hidden} 个文件（${collapsed.size} 个低活跃目录；深度上限 ${depth}）`);
    }
    return `# 地图 ${branch}｜${loaded.index!.counts.files} 文件｜形态 ${loaded.index!.views?.primary ?? '?'}\n` + lines.join('\n');
  };

  let text = renderNow();
  let tokens = estimateTokens(text);

  /* 折叠顺序：活跃度升序。冷目录先折，热的（有标签/有引用/有注记）最后。 */
  const candidates: TreeDir[] = [];
  const walk = (d: TreeDir) => {
    for (const sub of d.dirs.values()) {
      candidates.push(sub);
      walk(sub);
    }
  };
  walk(tree);
  candidates.sort((a, b) => activity(a) - activity(b));

  let collapsedCount = 0;
  for (const dir of candidates) {
    if (tokens <= budget) break;
    collapsed.add(dir.path);
    collapsedCount += 1;
    text = renderNow();
    tokens = estimateTokens(text);
  }

  return { text, tokens, collapsed: collapsedCount, files: loaded.index.counts.files };
}

// ── map_lookup ──────────────────────────────────────────────────────────────

export interface LookupResult {
  text: string;
  found: boolean;
  stale: boolean;
  groups: string[];
  kbLinks: BoundKbLink[];
  notes: MapNote[];
}

export function mapLookup(root: string, path: string, opts: { branch?: string; includeAncestors?: boolean } = {}): LookupResult {
  const loaded = loadAll(root);
  const norm = path.replace(/\\/g, '/');
  if (!loaded.index) return { text: '(还没有地图)', found: false, stale: false, groups: [], kbLinks: [], notes: [] };
  const branch = opts.branch ?? loaded.index.branch;
  const node = nodeFor(loaded, branch, norm);
  const links = kbLinksFor(root, branch, norm, { includeAncestors: opts.includeAncestors !== false });
  const notes = loaded.notes.filter((n) => n.path === norm);
  const groups = node?.groups ?? deriveGroups(norm, loaded.index.views);
  const stale = node ? labelIsStale(node) : false;

  const lines: string[] = [];
  lines.push(`${norm}`);
  if (!node) {
    lines.push('  (地图里没有这个节点：可能是新文件，跑 pnpm map:build 或看路径是否写错)');
  } else {
    if (node.label) lines.push(`  是什么  ${node.label}${stale ? '  ⚠ 这描述的是更早版本的内容' : ''}`);
    if (node.what) lines.push(`  干什么  ${node.what}`);
    if (node.when) lines.push(`  何时读  ${node.when}`);
    if (node.generated) lines.push('  ⚠ 生成物：改它会被重新生成覆盖');
    lines.push(`  引用    ${node.inDegree ?? 0} 处`);
  }
  lines.push(`  组      ${groups.slice(0, 8).join('  ')}${groups.length > 8 ? ` …共 ${groups.length}` : ''}`);

  /*
   * 收编：本地没有标签时回外部取。取不回来就明说"外部不可用"，不许静默当作没有。
   */
  if (!node?.label) {
    const refs = refsOf(root, branch, norm);
    if (refs.length) {
      const hit = resolveRef(refs[0]!, node?.sha1);
      if ('unavailable' in hit) {
        lines.push(`  外部收编：${hit.unavailable}（这条知识现在取不到，不是不存在）`);
      } else {
        const fresh = hit.fresh ? '' : '  ⚠ 外部那版已与本地内容不同，只作参考';
        lines.push(`  外部收编（来自 ${hit.ref.from}）：${hit.node.label ?? '(无标签)'}${fresh}`);
        if (hit.node.what) lines.push(`    ${hit.node.what}`);
      }
    }
  }

  const symbols = readSymbols(root);
  if (symbols && node) {
    const outline = symbolsInFile(symbols, norm).slice(0, 8);
    if (outline.length) {
      lines.push('  符号');
      for (const s of outline) lines.push(`    ${s.exported ? '★' : '·'} ${s.line}  ${s.kind} ${s.name} (引用 ${s.refs})`);
    }
  }

  if (links.length) {
    lines.push('  组结构知识');
    for (const l of links.slice(0, 8)) {
      const mark = l.confidence === 'certain' ? '★' : '○';
      const from = l.fromAncestor ? `  (来自上层 ${l.via})` : '';
      lines.push(`    ${mark} ${l.kbGroup} · ${l.title}${from}`);
    }
  }

  if (notes.length) {
    lines.push('  注记');
    for (const n of notes.slice(0, 8)) lines.push(`    [${n.kind}] ${n.text}${n.mayBeStale ? '  ⚠ 可能已过时' : ''}`);
  }

  const commits = logForPath(root, norm, 3);
  if (commits.length) {
    lines.push('  最近改动');
    for (const c of commits) lines.push(`    ${c.at} ${c.sha} ${c.subject}`);
  }

  return { text: lines.join('\n'), found: !!node, stale, groups, kbLinks: links, notes };
}

// ── map_whereis ─────────────────────────────────────────────────────────────

export interface WhereisHit {
  path: string;
  label?: string;
  score: number;
  reasons: string[];
  /** 引用数：只用于同分排序，不参与是否命中。 */
  refs: number;
}

export interface WhereisResult {
  hits: WhereisHit[];
  scanned: number;
  shardsExpanded: number;
  ms: number;
}

/**
 * 意图 → 位置。两级收窄：
 *   ① 先给**分片**打分（分片里有多少条命中词），只展开前 3 个；
 *   ② 再在展开的分片里给**节点**打分。
 * 这样即使仓里有 10 万文件，扫描量也只跟"相关的那几片"成正比（有上限 2000）。
 */
export function mapWhereis(root: string, query: string, opts: { limit?: number; maxScan?: number; branch?: string } = {}): WhereisResult {
  const started = Date.now();
  const loaded = loadAll(root);
  const limit = opts.limit ?? 5;
  const maxScan = opts.maxScan ?? 2000;
  if (!loaded.index) return { hits: [], scanned: 0, shardsExpanded: 0, ms: 0 };
  const branch = opts.branch ?? loaded.index.branch;

  const raw = query.toLowerCase().split(/[\s,，。;；:：/\\|]+/).filter((t) => t.length > 0);
  /*
   * 中文没有空格：整句当词元会一个都匹配不上。补 CJK bigram（上传/传失/失败/败重/重试），
   * 任一命中即算相关；命中两个以上的 bigram 的节点自然分更高。
   */
  const terms = [...new Set(raw.flatMap((t) => {
    if (!/[\u4e00-\u9fff]/.test(t) || t.length < 3) return [t];
    const grams: string[] = [t];
    for (let i = 0; i + 2 <= t.length; i += 1) grams.push(t.slice(i, i + 2));
    return grams;
  }))];
  if (!terms.length) return { hits: [], scanned: 0, shardsExpanded: 0, ms: 0 };

  const byShard = new Map<string, MapNode[]>();
  for (const node of loaded.nodes) {
    if (node.branch !== branch || node.kind !== 'file') continue;
    const key = node.path.includes('/') ? node.path.slice(0, node.path.indexOf('/')) : '_root';
    const list = byShard.get(key);
    if (list) list.push(node);
    else byShard.set(key, [node]);
  }

  const scoreNode = (node: MapNode) => {
    const hay = `${node.path} ${node.label ?? ''} ${node.what ?? ''} ${node.when ?? ''}`.toLowerCase();
    let score = 0;
    const reasons: string[] = [];
    for (const term of terms) {
      if (!hay.includes(term)) continue;
      score += 1;
      if ((node.label ?? '').toLowerCase().includes(term)) {
        score += 3;
        reasons.push(`标签命中「${term}」`);
      } else if ((node.what ?? '').toLowerCase().includes(term)) {
        score += 2;
        reasons.push(`说明命中「${term}」`);
      } else {
        reasons.push(`路径命中「${term}」`);
      }
    }
    /*
     * 引用数**不**进 score：它是"重要"，不是"相关"。
     * 之前把它当保底分，导致零命中的高引用文件也变成命中 —— 那是最坏的一类错误
     * （任何查询都得到同一批文件，看起来还很有把握）。
     */
    return { score, reasons };
  };

  const shardScores = [...byShard.entries()].map(([key, nodes]) => {
    let s = 0;
    for (const n of nodes) s += scoreNode(n).score;
    return { key, nodes, score: s };
  });
  shardScores.sort((a, b) => b.score - a.score);

  const hits: WhereisHit[] = [];
  let scanned = 0;
  let shardsExpanded = 0;
  for (const shard of shardScores) {
    if (shard.score <= 0 && shardsExpanded > 0) break;
    if (scanned >= maxScan) break;
    shardsExpanded += 1;
    const take = Math.min(shard.nodes.length, maxScan - scanned);
    for (const node of shard.nodes.slice(0, take)) {
      scanned += 1;
      const { score, reasons } = scoreNode(node);
      /* 命中判据：至少真的命中一个词。reasons 为空 = 一个词都没匹配上（不管引用数多高）。 */
      if (score <= 0 || reasons.length === 0) continue;
      hits.push({ path: node.path, label: node.label, score, reasons, refs: node.inDegree ?? 0 });
    }
    if (shardsExpanded >= 3) break;
  }

  hits.sort((a, b) => b.score - a.score || b.refs - a.refs || a.path.localeCompare(b.path));
  return { hits: hits.slice(0, limit), scanned, shardsExpanded, ms: Date.now() - started };
}

// ── map_impact ──────────────────────────────────────────────────────────────

export interface ImpactResult {
  text: string;
  reverse: string[];
  gates: GateHit[];
  tests: string[];
}

/** 改这些文件会波及谁 + 要跑哪些 gate + 相关测试。 */
export function mapImpact(root: string, paths: string[]): ImpactResult {
  const loaded = loadAll(root);
  const norm = paths.map((p) => p.replace(/\\/g, '/'));
  const reverseEdges = new Map<string, string[]>();
  for (const e of loaded.edges) {
    if (e.kind !== 'import') continue;
    const list = reverseEdges.get(e.to);
    if (list) list.push(e.from);
    else reverseEdges.set(e.to, [e.from]);
  }

  const reverse: string[] = [];
  /** 纯类型导入的反向依赖：只需重编译，不会在运行时炸。 */
  const typeOnlyCallers = new Set<string>();
  const seen = new Set(norm);

  const bfs = (seeds: string[]) => {
    const queue = [...seeds];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const from of reverseEdges.get(cur) ?? []) {
        if (seen.has(from)) continue;
        seen.add(from);
        reverse.push(from);
        queue.push(from);
      }
    }
  };

  /*
   * 先记下"只按类型引用我"的那些文件：它们属于"重编译"而不是"会炸"。
   * 注意边可能指向**包根**（裸包名 import），所以目标集合要包含"我所属的包根"。
   */
  const relevantTargets = new Set<string>(norm);
  for (const p of loaded.index?.views?.packages ?? []) {
    if (p.root === '.') continue;
    if (norm.some((n) => n === p.root || n.startsWith(p.root + '/'))) relevantTargets.add(p.root);
  }
  for (const e of loaded.edges) {
    if (e.kind !== 'import' || !e.typeOnly) continue;
    if (relevantTargets.has(e.to)) typeOnlyCallers.add(e.from);
  }
  bfs(norm);

  /*
   * 包级：裸包名 import 指向包根，不补这一层的话，"改共享包会影响谁"永远回"没人引用"。
   * 命中标「包级」，避免把"用了这个包"说成"用了这个文件"。
   */
  const pkgRoots = (loaded.index?.views?.packages ?? [])
    .filter((p) => p.root !== '.' && norm.some((n) => n === p.root || n.startsWith(p.root + '/')))
    .map((p) => p.root);
  const beforePkg = reverse.length;
  bfs(pkgRoots);
  for (let i = beforePkg; i < reverse.length; i += 1) reverse[i] = `${reverse[i]}（包级）`;

  const gates = gateFor(root, norm);
  const testish = new Set(loaded.nodes.filter((n) => n.kind === 'file' && /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[a-z]+$/i.test(n.path)).map((n) => n.path));
  const tests = [...seen].filter((p) => testish.has(p)).concat(
    [...reverseEdges.get(norm[0] ?? '') ?? []].filter((p) => testish.has(p)),
  );

  const lines: string[] = [];
  lines.push(`影响面：${norm.join(', ')}`);
  /* reverse 里的条目可能带「（包级）」后缀，比较前先剥掉，否则永远是 0 条仅类型。 */
  const bare = (p: string): string => p.replace(/（包级）$/, "");
  const valueCallers = reverse.filter((p) => !typeOnlyCallers.has(bare(p)));
  const onlyTypes = reverse.filter((p) => typeOnlyCallers.has(bare(p)));
  lines.push(`  反向 import（值）：${valueCallers.length ? valueCallers.slice(0, 10).join(', ') + (valueCallers.length > 10 ? ` …共 ${valueCallers.length}` : '') : '(没有文件按值引用它)'}`);
  if (onlyTypes.length) {
    lines.push(`  反向 import（仅类型，只需重编译）：${onlyTypes.slice(0, 6).join(', ')}${onlyTypes.length > 6 ? ` …共 ${onlyTypes.length}` : ''}`);
  }
  lines.push(`  要跑：${gates.map((g) => `${g.check}${g.exists ? '' : '(不存在?)'}`).join(', ') || '(未命中规则)'}`);
  lines.push(`  相关测试：${[...new Set(tests)].slice(0, 8).join(', ') || '(按路径没找到)'}`);
  return { text: lines.join('\n'), reverse, gates, tests: [...new Set(tests)] };
}

// ── map_scope ───────────────────────────────────────────────────────────────

export interface ScopeResult {
  text: string;
  files: string[];
  seeds: WhereisHit[];
  gates: GateHit[];
  tokens: number;
  ms: number;
}

export interface ScopeOptions {
  /** 最多给多少个文件（默认 60；100k 仓里"起点"不该超过一两百）。 */
  maxFiles?: number;
  /** 锚点扩几跳反向 import（默认 1：改它的直接调用方）。 */
  hops?: number;
  budgetTokens?: number;
}

/**
 * 工作集：给一个任务描述，圈出"从哪开始 + 改谁会被波及 + 要跑什么"。
 *
 * 顺序是刻意的：**锚点（意图命中）→ 反向依赖（谁会被改坏）→ 闸门（怎么验）**。
 * 三者缺一，模型就会要么在错误的文件里打转，要么改完不知道怎么验。
 */
export function mapScope(root: string, task: string, opts: ScopeOptions = {}): ScopeResult {
  const started = Date.now();
  const maxFiles = opts.maxFiles ?? 60;
  const hops = opts.hops ?? 1;
  const budget = opts.budgetTokens ?? 2500;

  const found = mapWhereis(root, task, { limit: 8 });
  const seeds = found.hits;
  const loaded = loadAll(root);
  const reverseEdges = new Map<string, string[]>();
  for (const e of loaded.edges) {
    if (e.kind !== 'import') continue;
    const list = reverseEdges.get(e.to);
    if (list) list.push(e.from);
    else reverseEdges.set(e.to, [e.from]);
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    const clean = p.replace(/（包级）$/, '');
    if (seen.has(clean) || ordered.length >= maxFiles) return;
    seen.add(clean);
    ordered.push(clean);
  };

  for (const seed of seeds) push(seed.path);

  let frontier = seeds.map((s) => s.path);
  for (let hop = 0; hop < hops; hop += 1) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const from of reverseEdges.get(cur) ?? []) {
        push(from);
        next.push(from);
      }
    }
    frontier = next;
  }

  const gates = gateFor(root, seeds.map((s) => s.path));
  const lines: string[] = [];
  lines.push(`工作集：「${task}」`);
  lines.push(`  锚点（意图命中）：${seeds.length ? '' : '（没有命中——标签密度还低，先把相关文件标注掉）'}`);
  for (const s of seeds) lines.push(`    ${s.score.toFixed(1).padStart(5)}  ${s.path}  ${s.label ?? ''}`);
  const dependents = ordered.slice(seeds.length);
  if (dependents.length) {
    lines.push(`  会被波及（反向 import，${dependents.length}）：`);
    for (const d of dependents.slice(0, 12)) lines.push(`    ${d}`);
    if (dependents.length > 12) lines.push(`    …共 ${dependents.length}`);
  }
  lines.push(`  要跑：${gates.map((g) => `${g.check}${g.exists ? '' : '(不存在?)'}`).join(', ') || '(未命中规则)'}`);

  let text = lines.join('\n');
  let tokens = estimateTokens(text);
  if (tokens > budget) {
    /* 超预算先砍"会被波及"的尾巴——锚点和闸门是结论，砍了就失去意义。 */
    const keep = dependents.slice(0, Math.max(0, 4));
    lines.splice(lines.indexOf('  会被波及（反向 import，' + dependents.length + '）：'), lines.length - 1,
      `  会被波及（反向 import，${dependents.length}）：${keep.join(', ')}${dependents.length > keep.length ? ' …' : ''}`,
      lines[lines.length - 1]!);
    text = lines.join('\n');
    tokens = estimateTokens(text);
  }

  return { text, files: ordered, seeds, gates, tokens, ms: Date.now() - started };
}

// ── map_contracts ───────────────────────────────────────────────────────────

export interface ContractsResult {
  text: string;
  certain: MapEdge[];
  threats: MapEdge[];
}

/**
 * 契约图：确定的一条条写出来，不确定的单列成「潜在威胁」。
 *
 * 分开列是刻意的：把两者混在一起，模型会把"可能 404"当成"一定 404"，
 * 或者反过来把确定契约当成猜测，两种都会让它改错地方。
 */
export function mapContracts(root: string): ContractsResult {
  const loaded = loadAll(root);
  const edges = loaded.edges.filter((e) => e.kind === 'contract');
  const certain = edges.filter((e) => e.confidence === 'certain');
  const threats = edges.filter((e) => e.confidence !== 'certain');

  const lines: string[] = [];
  /*
   * 三栏而不是两栏：确定 / 潜在威胁 / **无法对账**。
   * 第三栏是变量拼接的 URL——既不是确定也不是威胁，但必须让人看见，
   * 否则"零威胁"会被误读成"全都检查过"。
   */
  const unresolved = loaded.index?.contractUnresolved ?? 0;
  lines.push(
    `契约（HTTP）：确定 ${certain.length} 条｜潜在威胁 ${threats.length} 条｜无法对账 ${unresolved} 处（URL 是变量拼接）`,
  );
  if (certain.length) {
    lines.push('  确定（两端都定位到）：');
    for (const e of certain.slice(0, 20)) lines.push(`    ${e.from} → ${e.to}  ${e.evidence[0] ?? ''}`);
    if (certain.length > 20) lines.push(`    …共 ${certain.length}`);
  }
  if (threats.length) {
    lines.push('  潜在威胁（只有一端，或抽取器没对上）：');
    for (const e of threats.slice(0, 20)) {
      lines.push(`    ${e.evidence[0] ?? e.from}`);
      /*
       * 反证条件必须打出来：它原来只存在边的数据里，读者看到"66 条潜在威胁"会以为有 66 个 bug，
       * 而其中一部分只是抽取器的盲区（外部客户端、变量拼接）。一句 falsifier 就能说清。
       */
      if (e.falsifiers?.length) lines.push(`      ↳ 什么情况下它其实没问题：${e.falsifiers[0]}`);
    }
    if (threats.length > 20) lines.push(`    …共 ${threats.length}`);
  }
  return { text: lines.join('\n'), certain, threats };
}

// ── map_note / map_diff ─────────────────────────────────────────────────────

export function mapNote(
  root: string,
  input: { path: string; kind: MapNote['kind']; text: string; branch?: string },
): MapNote {
  const index = readIndex(root);
  const branch = input.branch ?? index?.branch ?? 'main';
  const sha = sha1Of(root, input.path, gitIn(root)) ?? undefined;
  return addNote(root, branch, { branch, path: input.path.replace(/\\/g, '/'), kind: input.kind, text: input.text, sha1: sha, mayBeStale: false });
}

export function mapDiff(root: string, paths: string[] = []): string {
  const stats = numStat(root, null, paths);
  if (!stats.length) return '(工作区没有未提交的改动)';
  const rows = stats.map((s) => `  ${s.path}  +${s.added}/-${s.removed}`);
  const st = status(root);
  return [`未提交改动（${stats.length} 个文件）：`, ...rows, `工作区状态：${st.length} 项待提交`].join('\n');
}
