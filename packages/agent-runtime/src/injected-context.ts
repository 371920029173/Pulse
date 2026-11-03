/*
 * 注入块（【本轮自动召回】/【这轮常用的工具】/【工作区地图】）只应该在**请求**里存在。
 * 模型有时会把它复述进自己的输出；一旦那份输出落盘，就会在压缩里越滚越大。
 * 这个函数负责在落盘前剔掉它们 —— 单独成模块，好让判据直接测它。
 */
const INJECTED_MARKERS = ['【本轮自动召回】', '【这轮常用的工具】', '【工作区地图】', '【自动召回】'];

export function stripInjectedContext(text: string): string {
  if (!text) return text;
  let out = text;
  for (const marker of INJECTED_MARKERS) {
    let at = out.indexOf(marker);
    while (at >= 0) {
      const rest = out.slice(at + marker.length);
      const gap = rest.search(/\n\s*\n/);
      const end = gap >= 0 ? at + marker.length + gap : out.length;
      out = (out.slice(0, at) + out.slice(end)).replace(/\n{3,}/g, '\n\n').trimEnd();
      at = out.indexOf(marker);
    }
  }
  return out;
}
