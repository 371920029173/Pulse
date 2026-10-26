/*
 * 硬上限：请求不能带着整段转写去见模型。
 *
 * 事故（2026-10-26，AGI-3.5-v2 的父会话）：run trace 里三条请求的 prompt 分别是
 * 432,724 / 434,783 / 436,846 tokens —— 会话累计 39,894 条消息，而**没有任何东西在截断它**。
 * 结果是每一轮都在重发 43 万 token：贵、慢，而且一旦超过模型窗口，服务端会自己截断，
 * 截断点不受我们控制（工具调用与结果配不上对，模型就像"看不见上下文"）。
 *
 * 这里只做一件事：**超过上限就从最老的开始整块丢**，并且保证留下的第一条不是 tool
 * （tool 消息必须紧跟着它的 tool_calls，掉一半就成了非法请求）。
 *
 * 为什么不做摘要：摘要是另一件事（要花一次模型调用、要冻结、要落盘）。这条是在
 * "摘要还没做/没生效"时也必须成立的底线——宁可少几轮旧上下文，也不能发一个 43 万 token
 * 的请求出去。
 */

/** 每 token 大约多少字符。与 token 估算其它地方保持一致（中文为主的实测值）。 */
const CHARS_PER_TOKEN = 3.47;

export const DEFAULT_PROMPT_TOKEN_CAP = 96_000;

/** 环境变量 `SHE_PROMPT_TOKEN_CAP`；非法值退回默认（宁可截断，也不要无声地放行）。 */
export function promptTokenCap(): number {
  const raw = Number(process.env.SHE_PROMPT_TOKEN_CAP);
  return Number.isFinite(raw) && raw >= 4_000 ? Math.floor(raw) : DEFAULT_PROMPT_TOKEN_CAP;
}

export interface CappableMessage {
  role: string;
  content: string;
  tool_calls?: { id?: string }[];
  tool_call_id?: string;
}

function estimate(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * 从头丢到能装下为止，返回 `{ messages, dropped }`。
 *
 * 两条不变量：
 *   1. 留下的第一条**不能是 tool** —— 它的 tool_calls 已被丢掉的话，这一次请求是非法的；
 *   2. 不拆开 `assistant(tool_calls) → tool` 这一组：要丢就丢到它前面的 user 之前。
 */
export function capMessages<T extends CappableMessage>(messages: T[], capTokens = promptTokenCap()): { messages: T[]; dropped: number } {
  let total = 0;
  for (const m of messages) total += estimate(m.content ?? '') + estimate(JSON.stringify(m.tool_calls ?? []));
  if (total <= capTokens) return { messages, dropped: 0 };

  let keepFrom = messages.length;
  let kept = 0;
  for (let i = messages.length - 1; i >= 1; i -= 1) {
    const m = messages[i];
    const cost = estimate(m.content ?? '') + estimate(JSON.stringify(m.tool_calls ?? []));
    if (kept + cost > capTokens) break;
    kept += cost;
    keepFrom = i;
  }

  /* 起点必须是 user 或 assistant：tool / 续写的碎片都不能当第一条。 */
  while (keepFrom < messages.length && messages[keepFrom].role === 'tool') keepFrom += 1;
  /* 若第一条 assistant 带 tool_calls，它的结果必须也在 —— 否则整组不要。 */
  while (keepFrom < messages.length && messages[keepFrom].role === 'assistant' && (messages[keepFrom].tool_calls ?? []).length) {
    keepFrom += 1;
    while (keepFrom < messages.length && messages[keepFrom].role === 'tool') keepFrom += 1;
  }
  if (keepFrom >= messages.length) return { messages, dropped: 0 };

  /* 系统消息（如果调用方把它放在数组里）永远保留。 */
  const head = messages[0]?.role === 'system' ? [messages[0]] : [];
  const rest = messages.slice(keepFrom).filter((m) => m.role !== 'system');
  return { messages: [...head, ...rest], dropped: keepFrom - head.length };
}
