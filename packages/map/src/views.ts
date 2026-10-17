/*
 * 三个视角的探测：包 / 仓 / 构建单元。
 *
 * 用户的原话是"我并不知道我的仓是哪种形态"，所以这里不要求他选：**能探到哪个就用哪个**，
 * 一个都探不到就退回目录轴（永远可用，绝不因为探测失败而整张图打不开）。
 *
 * 探测全部只读 manifest 与目录名，不跑构建工具 —— 一次 readdir + 几个小文件，
 * 在 10 万文件的仓里也是毫秒级，不会成为建图的成本项。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

export type ViewKind = 'package' | 'repo' | 'target' | 'dir';

export interface DetectedPackage {
  name: string;
  root: string;
  kind: 'npm' | 'go' | 'python' | 'rust';
  manifest: string;
}

export interface DetectedRepo {
  name: string;
  root: string;
  kind: 'git' | 'submodule';
}

export interface DetectedTarget {
  root: string;
  kind: 'bazel' | 'cmake' | 'make' | 'tsconfig';
  file: string;
}

export interface DetectedViews {
  packages: DetectedPackage[];
  repos: DetectedRepo[];
  targets: DetectedTarget[];
  /** 默认视图：探不到时是 `dir`，此时地图仍然完整可用。 */
  primary: ViewKind;
  /** 探测依据，写进 index 便于人肉排查"为什么它是这个形态"。 */
  evidence: string[];
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * workspace 的 glob 展开。
 *
 * 只支持最常见的 `packages/*` / `apps/*` 形式，外加 `!` 排除：
 * 完整 glob 语义（**、{}、[]）在这里没有价值 —— 探不到就是探不到，退回目录轴即可，
 * 而一个半吊子的 glob 引擎会安静地漏掉成员，那比不探测更坏。
 */
export function expandGlobs(root: string, patterns: string[]): string[] {
  const out = new Set<string>();
  const negations = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  for (const raw of patterns) {
    if (raw.startsWith('!')) continue;
    const pat = raw.replace(/^\.\//, '').replace(/\/$/, '');
    const star = pat.indexOf('*');
    if (star < 0) {
      if (isDir(join(root, pat))) out.add(pat);
      continue;
    }
    const parent = pat.slice(0, pat.lastIndexOf('/', star)).replace(/\/$/, '');
    const base = parent ? join(root, parent) : root;
    let entries: string[] = [];
    try {
      entries = readdirSync(base).filter((n) => isDir(join(base, n)));
    } catch {
      continue;
    }
    for (const name of entries) {
      const rel = parent ? posix.join(parent, name) : name;
      out.add(rel);
    }
  }
  for (const n of negations) out.delete(n);
  return [...out].sort();
}

function detectPackages(root: string, evidence: string[]): DetectedPackage[] {
  const pkgs: DetectedPackage[] = [];

  /** npm/pnpm workspace：根 package.json 的 workspaces 或 pnpm-workspace.yaml，两者都要看。 */
  let wsPatterns: string[] = [];
  const rootPkg = readJson(join(root, 'package.json'));
  if (rootPkg) {
    const ws = rootPkg.workspaces;
    if (Array.isArray(ws)) wsPatterns = ws;
    else if (ws && Array.isArray(ws.packages)) wsPatterns = ws.packages;
    if (wsPatterns.length) evidence.push('package.json#workspaces');
  }
  const pnpmWs = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWs)) {
    const text = readFileSync(pnpmWs, 'utf8');
    const found = [...text.matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1]!.trim());
    if (found.length) {
      wsPatterns = wsPatterns.concat(found);
      evidence.push('pnpm-workspace.yaml');
    }
  }

  for (const rel of expandGlobs(root, wsPatterns)) {
    const manifest = join(root, rel, 'package.json');
    const pkg = readJson(manifest);
    if (!pkg) continue;
    pkgs.push({ name: String(pkg.name ?? rel), root: rel, kind: 'npm', manifest: `${rel}/package.json` });
  }

  /** 单语言仓的包边界：go.mod / pyproject.toml / Cargo.toml 出现在子目录里也算。 */
  const markers: Array<[string, DetectedPackage['kind']]> = [
    ['go.mod', 'go'],
    ['pyproject.toml', 'python'],
    ['Cargo.toml', 'rust'],
  ];
  if (pkgs.length === 0) {
    for (const dir of ['', ...expandGlobs(root, ['*'])]) {
      for (const [file, kind] of markers) {
        const rel = dir ? posix.join(dir, file) : file;
        if (existsSync(join(root, rel))) {
          pkgs.push({ name: dir || root.split(/[\\/]/).pop() || 'root', root: dir || '.', kind, manifest: rel });
          evidence.push(rel);
        }
      }
    }
  }

  return pkgs;
}

function detectRepos(root: string, evidence: string[]): DetectedRepo[] {
  const repos: DetectedRepo[] = [];
  if (isDir(join(root, '.git')) || existsSync(join(root, '.git'))) {
    repos.push({ name: root.split(/[\\/]/).pop() || 'root', root: '.', kind: 'git' });
  }
  /** 子模块 = 多仓的最常见形态（同一份代码里嵌别人的仓）。 */
  const gm = join(root, '.gitmodules');
  if (existsSync(gm)) {
    evidence.push('.gitmodules');
    const text = readFileSync(gm, 'utf8');
    for (const m of text.matchAll(/^\[submodule "([^"]+)"\]/gm)) {
      const name = m[1]!;
      const block = text.slice(m.index ?? 0).split('[submodule')[0] ?? '';
      const pathMatch = block.match(/^\s*path\s*=\s*(.+)$/m);
      repos.push({ name, root: pathMatch ? pathMatch[1]!.trim() : name, kind: 'submodule' });
    }
  }
  return repos;
}

function detectTargets(root: string, evidence: string[]): DetectedTarget[] {
  const targets: DetectedTarget[] = [];
  const mark = (cond: boolean, rel: string, kind: DetectedTarget['kind'], dir = '') => {
    if (!cond) return;
    targets.push({ root: dir || '.', kind, file: dir ? posix.join(dir, rel) : rel });
    evidence.push(dir ? posix.join(dir, rel) : rel);
  };

  mark(existsSync(join(root, 'WORKSPACE')) || existsSync(join(root, 'WORKSPACE.bazel')), 'WORKSPACE', 'bazel');
  mark(existsSync(join(root, 'CMakeLists.txt')), 'CMakeLists.txt', 'cmake');
  mark(existsSync(join(root, 'Makefile')), 'Makefile', 'make');
  mark(existsSync(join(root, 'tsconfig.json')), 'tsconfig.json', 'tsconfig');

  /** 顶层目录里各有一个 BUILD/CMakeLists 是很常见的（多包 monorepo），抽前 40 个避免爆炸。 */
  let tops: string[] = [];
  try {
    tops = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .slice(0, 40);
  } catch {
    tops = [];
  }
  for (const dir of tops) {
    if (targets.length > 40) break;
    for (const [file, kind] of [
      ['BUILD.bazel', 'bazel'],
      ['BUILD', 'bazel'],
      ['CMakeLists.txt', 'cmake'],
      ['tsconfig.json', 'tsconfig'],
    ] as Array<[string, DetectedTarget['kind']]>) {
      if (existsSync(join(root, dir, file))) targets.push({ root: dir, kind, file: posix.join(dir, file) });
    }
  }
  return targets;
}

export function detectViews(root: string): DetectedViews {
  const evidence: string[] = [];
  const packages = detectPackages(root, evidence);
  const repos = detectRepos(root, evidence);
  const targets = detectTargets(root, evidence);

  /*
   * 优先级：包 > 构建单元 > 仓 > 目录。
   * 理由：模型问"这是干什么的"时，包边界最贴近人能理解的单元；构建单元次之（它解释
   * "为什么这堆文件必须一起改"）；纯目录只在什么都没探到时兜底。
   */
  /*
   * 仓视角只在**多仓**时成立：一个仓的仓视图只有一个节点，等于没视图。
   * 单仓且没有 manifest 时，真正有用的是目录轴。
   */
  const primary: ViewKind = packages.length
    ? 'package'
    : targets.length
      ? 'target'
      : repos.filter((r) => r.kind === 'submodule').length > 0
        ? 'repo'
        : 'dir';
  if (!packages.length && !targets.length && primary === 'dir') evidence.push('未探测到可用的划分依据（包/构建单元/多仓），退回目录轴');

  return { packages, repos, targets, primary, evidence };
}
