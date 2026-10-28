import { mapImpact } from '@she/map';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** 从一段话里认出的工作区文件（最多 2 个，去重，按出现顺序）。 */
export function mentionedFiles(root: string, text: string, max = 2): string[] {
  const out: string[] = [];
  const re = /((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|cjs|py|go|rs|c|h|cc|cpp|json|md|mjs))/g;
  /* 只扫前 20k：一屏就够找出被提到的文件，而用户可能贴进来几十万字符的日志。 */
  for (const m of String(text ?? '').slice(0, 20_000).matchAll(re)) {
    const p = m[1].replace(/\\/g, '/');
    if (out.includes(p)) continue;
    if (!existsSync(join(root, p))) continue;
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 一行影响面：谁引用它、该跑哪些 check。
 *
 * 只取 map_impact 输出里**最能改变决定的两样**（反向引用数、要跑的 check），
 * 其余留给 map_impact 本体 —— 这一行的目的是"提醒它去看"，不是替代它。
 */
export function mapImpactLine(root: string, text: string): string {
  let paths: string[] = [];
  try {
    paths = mentionedFiles(root, text);
  } catch {
    return '';
  }
  if (!paths.length) return '';
  const lines: string[] = [];
  for (const p of paths) {
    try {
      const r = mapImpact(root, [p]);
      const parts: string[] = [];
      if (r.reverse.length) parts.push(`被 ${r.reverse.length} 处引用`);
      if (r.gates.length) parts.push(`要跑 ${r.gates.map((g) => g.check).join('、')}`);
      if (r.tests.length) parts.push(`相关测试 ${r.tests.length} 个`);
      lines.push(`- ${p}：${parts.length ? parts.join('；') : '地图里还没有它的记录（先 map_tree 建一次）'}`);
    } catch {
      /* 地图读不了就跳过：这一行是锦上添花，绝不能挡对话 */
    }
  }
  if (!lines.length) return '';
  return `【改动前的影响面】改这些文件前先看一眼（细节用 map_impact）：\n${lines.join('\n')}`;
}
