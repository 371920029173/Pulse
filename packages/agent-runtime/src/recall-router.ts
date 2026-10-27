/*
 * L2 条件锚路由（纯规则，零模型调用，零缓存成本）。
 *
 * 为什么需要：现在每一轮都走同一套召回。读代码的轮次和"你好"的轮次被同等对待 ——
 * 前者该多查、后者根本不该查（查了就是污染 + 每轮多几百 token）。
 *
 * 规则只用**用户这句话**判断，不看历史，所以：
 *   · 不花模型调用；
 *   · 相同输入永远得到相同计划（不会让同一轮一会查一会不查，破坏"一轮一次"的缓存假设）。
 *
 * 输出是"检索计划"而不是"查/不查"：任务类型决定优先看哪几个组、预算多少。
 */

export type TaskKind = 'code' | 'history' | 'writing' | 'chat';

export interface RecallPlan {
  kind: TaskKind;
  /** 优先看的组前缀（命中的结果排在前面，不是硬过滤 —— 硬过滤会误杀跨组记忆）。 */
  preferGroups: string[];
  /** 这一轮召回块的字数预算。 */
  budgetChars: number;
  /** 给状态行用的一句话（s4 会把它写进请求末尾）。 */
  reason: string;
}

const CODE_SIGNALS = [
  /\.(ts|tsx|js|mjs|cjs|py|go|rs|c|h|cc|cpp|java|kt|rb|php|json|ya?ml|toml|sql|sh|ps1|bat|md)\b/i,
  /\b(npm|pnpm|node|git|tsc|eslint|vitest|tsx|docker|kubectl)\b/i,
  /(编译|报错|构建|测试|函数|接口|依赖|重构|修复|实现|改一下|加个|删掉|报错|崩溃|卡死|内存|性能|超时)/,
  /\b(fix|refactor|implement|compile|build|test|debug|error|exception)\b/i,
];

const HISTORY_SIGNALS = [
  /(之前|上次|上次说|我们说过|以前|历史|记得|当初|为什么这么|为什么这样|决定过|约定|惯例)/,
  /(知识库|kb|回忆|找一下|查一下|有没有记录)/i,
];

const WRITING_SIGNALS = [
  /(写一份|写成|文档|README|说明|总结|报告|发布说明|changelog|公告|邮件|文案)/i,
];

function score(text: string, patterns: RegExp[]): number {
  return patterns.reduce((n, re) => (re.test(text) ? n + 1 : n), 0);
}

/** 明确是寒暄/应答：这些才值得跳过召回（名单短、可读、改起来不心虚）。 */
const SMALL_TALK = /^[\s]*(你好|您好|嗨|在吗|在不在|谢谢|谢了|多谢|好的|好|嗯|收到|继续|明白|明白了|懂了|行|可以|ok|okay|hi|hello|thanks|thank you)[\s!！。.~]*$/i;

/** 明确是寒暄才算"不该查"；其余一律按有可能要查处理。 */
export function isSmallTalk(text: string): boolean {
  return SMALL_TALK.test(String(text ?? ''));
}

export function planRecall(text: string): RecallPlan {
  const t = String(text ?? '');
  if (!t.trim()) return { kind: 'chat', preferGroups: [], budgetChars: 0, reason: '空消息' };
  if (isSmallTalk(t)) return { kind: 'chat', preferGroups: [], budgetChars: 0, reason: '寒暄/应答，本轮不召回' };

  const code = score(t, CODE_SIGNALS);
  const history = score(t, HISTORY_SIGNALS);
  const writing = score(t, WRITING_SIGNALS);

  /* 历史类优先：问"上次为什么这么定"时，代码信号往往只是被提到的对象。 */
  if (history > 0 && history >= code) {
    return {
      kind: 'history',
      preferGroups: ['decisions', 'project', 'errors', 'architecture'],
      budgetChars: 1_600,
      reason: '问的是过去的决定/约定，优先查 decisions / project / errors',
    };
  }
  if (code > 0) {
    return {
      kind: 'code',
      preferGroups: ['architecture', 'project', 'errors'],
      budgetChars: 1_400,
      reason: '在改代码/查代码，优先查 architecture / project / errors',
    };
  }
  if (writing > 0) {
    return {
      kind: 'writing',
      preferGroups: ['architecture', 'project', 'docs'],
      budgetChars: 1_000,
      reason: '在写文档，优先查 architecture / project / docs',
    };
  }
  /*
   * 到这里说明没认出任务类型。**默认召回一次**，只有明确是寒暄才跳过 ——
   * 反过来做过一次，就出了事故：`这条会话的登录流程是怎么做的？` 被判成闲聊，
   * 于是请求里没有召回块，模型自然也不会补查。
   */
  return {
    kind: 'history',
    preferGroups: ['project', 'decisions', 'errors'],
    budgetChars: 800,
    reason: '没认出任务类型，保守召回一次',
  };
}
