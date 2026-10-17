/*
 * 组：不是树，是 DAG。
 *
 * 用户的原话："文件夹也作为一个文件检索，因为有的知识是跟整体层级来的"。这句话有两个含义，
 * 这里各实现一半：
 *   ① 目录本身就是检索单位 —— 所以每个祖先目录都是一个组，文件自动属于它；
 *   ② 但"文件属于哪个功能"不能靠目录表达 —— 一个功能横跨 ui/api/db/tests，
 *      所以组的成员关系是多对多的，同一个文件可以同时属于 `layer:ui`、`pkg:@she/ui`、
 *      `feat:context-compaction` 三个组。
 *
 * 目录轴、包轴、层轴由路径确定性推导（零成本、随时可重算）；功能轴只能由模型在干活时
 * 标注（`annotate({groups:[...]})`），这里不猜。
 */
import type { MapViews } from '@she/shared';

/** 组的命名空间前缀，防止不同轴撞名。 */
export type GroupAxis = 'dir' | 'pkg' | 'layer' | 'feat';

/** 层轴：按路径前缀判定，最粗糙但最稳定的一刀。 */
const LAYER_BY_PREFIX: Array<[RegExp, string]> = [
  [/^packages\/ui\//, 'ui'],
  [/^packages\/server\//, 'service'],
  [/^packages\/kb\//, 'knowledge'],
  [/^packages\/sandbox\//, 'sandbox'],
  [/^packages\/agent-runtime\//, 'agent'],
  [/^packages\/shared\//, 'contract'],
  [/^packages\/desktop\//, 'desktop'],
  [/^scripts\//, 'tools'],
  [/^docs\//, 'docs'],
  [/^evals\//, 'eval'],
  [/^skills\//, 'skills'],
];

/** 测试是一"层"而不是一"包"：它横切所有包，改代码前最先要看的就是它。 */
const TEST_PATH = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[a-z]+$/i;

function layerOf(path: string): string {
  if (TEST_PATH.test(path)) return 'test';
  for (const [re, layer] of LAYER_BY_PREFIX) if (re.test(path)) return layer;
  return 'other';
}

/** 文件所属的组：目录轴（含全部祖先）+ 包轴 + 层轴。功能轴由模型标注后并入。 */
export function deriveGroups(path: string, views?: MapViews): string[] {
  const groups = new Set<string>();

  const segs = path.split('/');
  for (let i = 0; i < segs.length; i += 1) groups.add(`dir:${segs.slice(0, i + 1).join('/')}`);
  if (segs.length > 1) groups.add('dir:.');

  for (const pkg of views?.packages ?? []) {
    const root = pkg.root === '.' ? '' : `${pkg.root}/`;
    if (root && path.startsWith(root)) groups.add(`pkg:${pkg.name}`);
    else if (!root) groups.add(`pkg:${pkg.name}`);
  }

  groups.add(`layer:${layerOf(path)}`);
  return [...groups];
}

/** 路径的祖先目录（由近到远），用于"知识向上冒泡"。 */
export function ancestorDirs(path: string): string[] {
  const segs = path.split('/');
  const out: string[] = [];
  for (let i = segs.length - 1; i >= 0; i -= 1) out.push(segs.slice(0, i).join('/') || '.');
  return out;
}

/** 组路径是否包含另一个（`dir:packages/ui` 包含 `dir:packages/ui/src`）。 */
export function groupContains(ancestor: string, descendant: string): boolean {
  const [aAxis, aPath] = ancestor.split(':');
  const [dAxis, dPath] = descendant.split(':');
  if (aAxis !== dAxis) return false;
  if (aPath === dPath) return true;
  if (aPath === '.') return true;
  return dPath.startsWith(`${aPath}/`);
}
