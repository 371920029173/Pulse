/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 把用户给的路径关进工作区 —— 全产品**只此一份**实现
 *
 * 这条逻辑原来有四份拷贝，四份的注释里都写着"只此一份才好"：
 *
 *   packages/sandbox/src/shell.ts   `resolveInsideWorkspace`
 *   packages/server/src/index.ts    `jailToWorkspace`
 *   packages/server/src/files.ts    `jailPath`
 *   packages/agent-runtime/…/lsp-tools.ts  `resolveInWorkspace`   ← 这一份漏了软链接
 *
 * 前三份各自跟着软链接复查，第四份只做了文本判定（join / relative），于是同一个夹具在两处
 * 得到相反结论：工作区里放一个指向 %TEMP% 的链接，`fs_read` 回 "Path escapes workspace via
 * link"，而 `lsp_diagnostics` 照常把工作区外的文件读出来给了诊断（第七轮实测，lsp-tools.ts:127）。
 * 这不是"某一处写错了"，是"同一件事有四个答案"——`files.ts` 里那句注释就是预言：
 * "A second copy of this logic is how a jail quietly develops a hole in one place only."
 *
 * 所以这里收成一份，四边都改为调用它。判定只有一条，写一次。
 *
 * ## 两道检查，缺一不可
 *
 *   1. **文本判定**：`resolve` 之后相对 `root` 还出不出得去。挡的是 `..` 与"绝对路径伪装成
 *      相对路径"（`resolve(root, 'C:\\Windows')` 会静默返回那个绝对路径）。
 *   2. **软链接复查**：路径形态上在区内，但真实目标是区外的链接。文本判定的结果**必须是这个
 *      结论的前提**，否则检查就不叫检查了。
 *
 * 第 2 步在目标还不存在时回退到"解析它已存在的父目录"——新建文件要走这条，否则"写一个新文件"
 * 会因为 `realpath` 抛错而被误判。回退**不是**放宽：父目录仍要在区内。
 *
 * 错误文案与四份拷贝逐字相同，历史检查与文档引用的是这两个串。
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/**
 * `candidate` 是否落在 `base` 里面。
 *
 * 用**相对段**判定而不是 `startsWith`：后者被共享前缀骗过（`"<ws>/.she/skills-backup/x.md"`
 * 以 `"<ws>/.she/skills"` 开头，于是名字只是以目标开头的兄弟目录被判成区内 —— 实测可读，其中
 * 一条路由还可删）。比较相对段骗不过去。
 *
 * `allowEqual` 默认关着，因为这个函数守的是**容器**（skills 目录、profile 目录）：容器本身不是
 * 合法目标。守"目录里的东西"时调用方显式打开它。
 *
 * Windows 上折叠大小写：同一个目录的大小写不同写法必须算同一个目录，否则 `C:\Ws` 与 `c:\ws`
 * 会被判成"逃逸"——那是把守得住的路径拒掉，比漏放更早被人绕过去（`SHE_CONTROL_AUTH=off` 那类）。
 */
export function isInsideDir(base: string, candidate: string, allowEqual = false): boolean {
  const fold = (p: string) => (IS_WINDOWS ? p.toLowerCase() : p);
  const b = fold(resolve(base));
  const c = fold(resolve(candidate));
  if (c === b) return allowEqual;
  const rel = relative(b, c);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

export interface JailedPath {
  /** 文本形态的绝对路径（`resolve` 之后的样子）——调用方要原样回显给用户时用它。 */
  abs: string;
  /**
   * 真实路径（软链接展开之后）。
   *
   * 目标还不存在时是"已存在父目录的真实路径 + 文件名"。`realpath` 本身失败（盘符解析不了等）
   * 时与 `abs` 相同 —— 这里只降级成"不做软链接展开"，不会因此放行一个文本上就在区外的路径
   * （那一步在前面已经拒绝了）。
   */
  real: string;
  /** 文本形态相对工作区（`relative(root, abs)`），调用方要落盘相对路径时用它。 */
  rel: string;
}

/**
 * 把一个绝对路径变成"真实路径"，目标还不存在时也能给答案。
 *
 * 沿祖先一路向上找到**第一个存在的目录**，展开它，再把缺的那几段接回去。四份旧实现都只回退
 * **一层**（`dirname` 一下），那在 Windows 上有个真实的坑：
 *
 *   `os.tmpdir()` 给的是 8.3 短名（`C:\Users\ADMINI~1\AppData\Local\Temp\…`），而 `realpath`
 *   给长名。当直接父目录**也不存在**时，回退那一层也失败，于是 `real` 停在短名、`realRoot` 已经
 *   是长名，同一个目录被判定成"逃逸" —— 拒绝的是工作区**里面**的路径。
 *
 * 实测：工作区根在临时目录下时 `resolveWorkspacePath(root, 'src/a.ts')`（`src` 还没建）抛
 * "Path escapes workspace via link"。这个用例是本文件收成一份之后才写的，所以它暴露的是四份
 * 旧实现**都有**的老坑，不是合并引入的 —— 只是四份里没有一份有人测过这条路径。
 *
 * 往上找祖先不会削弱那一步检查：缺失的那几段不存在，所以不可能是软链接；真正要展开的中间那段
 * （存在的祖先）仍然会被展开 —— `root/指向区外的链接/还不存在的文件.txt` 照样被拒。
 */
function toRealPath(abs: string): string {
  const missing: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return missing.length ? join(real, ...missing) : real;
    } catch {
      const parent = dirname(current);
      // 到顶了（连盘符根都解析不了）：保留文本形态，不因为盘的问题拒绝一个区内的路径。
      if (parent === current) return abs;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * 解析并在必要时拒绝。拒绝的两种形状各一条信息，因为"为什么被拒"决定下一步怎么做：
 * 前者请改路径写法，后者请检查工作区里有没有人放了链接。
 *
 * 空路径按 `.`（工作区根）处理 —— 四个调用方原来都这么写。
 */
export function resolveWorkspacePath(root: string, requested: string): JailedPath {
  const wanted = requested || '.';
  const abs = resolve(root, wanted);

  // ── 第 1 步：文本判定 ──
  let rel = relative(root, abs);
  if (IS_WINDOWS) rel = rel.replace(/\//g, '\\');
  /*
   * 三个条件都在挡不同的写法：`..` 前缀是普通的向上逃逸；`rel === '..'` 是"正好落在父目录"；
   * `/^[a-zA-Z]:/` 与 `isAbsolute` 挡的是"另一个盘符"——Windows 上 `relative` 跨盘会返回一个
   * 绝对路径而不是 `..` 序列，只查 `..` 会把它当成区内路径放过。
   */
  if (rel.startsWith('..') || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }

  // 归一化之后再比一次：上面用的是没归一化的输入，`C:\a\..\..\b` 这类写法在这里露出来。
  const nr = normalize(root);
  const na = normalize(abs);
  const fold = (p: string) => (IS_WINDOWS ? p.toLowerCase() : p);
  const cr = fold(nr);
  const ca = fold(na);
  if (ca !== cr && !ca.startsWith(cr.endsWith(sep) ? cr : cr + sep)) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }

  // ── 第 2 步：跟进软链接 ──
  /*
   * 根正常都是存在的，所以这里几乎总是第一条分支；异常时保留文本形态而不是拒绝 —— 盘的问题
   * 不该表现成"路径越界"。
   */
  let realRoot = nr;
  try { realRoot = realpathSync.native(nr); } catch { /* 保留文本形态 */ }

  const real = toRealPath(na);

  const realRootFold = fold(realRoot);
  const realFold = fold(real);
  if (realFold !== realRootFold
      && !realFold.startsWith(realRootFold.endsWith(sep) ? realRootFold : realRootFold + sep)) {
    throw new Error(`Path escapes workspace via link: ${requested}`);
  }

  return { abs, real, rel };
}

/** 文本形态的绝对路径。要原样回显用户给的路径时用它（`fs_*` 三条通道）。 */
export function jailWorkspacePath(root: string, requested: string): string {
  return resolveWorkspacePath(root, requested).abs;
}

/**
 * 真实路径（软链接已展开）。要**打开**这个路径时用它。
 *
 * 单独给一个出口而不是让调用方自己 `realpath`：谁自己再算一遍，谁就又有了第二个答案。
 */
export function realPathInWorkspace(root: string, requested: string): string {
  return resolveWorkspacePath(root, requested).real;
}
