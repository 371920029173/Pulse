/*
 * 给旧节点补 recall_when —— 提议逻辑（纯函数，可测）。
 *
 * 为什么不写个脚本直接扫库：**知识库只许经 kb_* 工具访问**（仓库规则 + 沙箱强制）。
 * 所以在进程内做成一个只读工具 `kb_recall_gaps`：它列出"还没有召回条件"的节点并给出候选，
 * 采纳与否由人（或模型）逐条 `kb_edit` 决定 —— 机械模板批量写库会让检索按模板措辞命中错东西。
 */

const FILE_RE = /((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|tsx|js|mjs|py|go|rs|c|h|cpp|json|md))/g;
const ENV_RE = /\b(SHE_[A-Z0-9_]+)\b/g;

/**
 * 一条候选触发条件：能从标题/正文/组名里读出什么就写什么，读不出就退到"涉及「标题」时"。
 *
 * 顺序有意义：先看"决定/取舍"（这类记忆的回答对象是理由），再看"坑"（对象是症状），
 * 然后是文件、环境变量 —— 越靠前越具体，越不可能和其它记忆撞车。
 */
export function proposeRecallWhen(title: string, content: string, groupPath: string): string {
  /* 节点正文可能有几万字符（导入的文档），只取前 20k 就够判断触发条件。 */
  const text = `${title}\n${content}`.slice(0, 20_000);
  const files = [...new Set([...text.matchAll(FILE_RE)].map((m) => m[1]))].slice(0, 2);
  const envs = [...new Set([...text.matchAll(ENV_RE)].map((m) => m[1]))].slice(0, 2);
  const g = String(groupPath ?? '').toLowerCase();

  if (/决定|为什么|取舍|选型|不用|改用/.test(title)) return '再次讨论同类取舍/为什么这样设计时';
  if (/踩坑|坑|报错|崩溃|失败|事故/.test(title) || /error|pitfall|trap/.test(g)) return '遇到同类报错或症状时';
  if (files.length) return `改 ${files.join(' / ')} 时`;
  if (envs.length) return `配置或环境相关（${envs.join(' / ')}）时`;
  if (/约定|规范|规则|口径/.test(title)) return '写新代码/新文档要遵守约定时';
  if (/接口|字段|格式|契约/.test(title)) return '对接或改接口时';
  return `涉及「${String(title).replace(/\s+/g, ' ').slice(0, 14)}」时`;
}
