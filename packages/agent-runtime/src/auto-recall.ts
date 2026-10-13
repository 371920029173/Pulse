/**
 * 自动召回：每轮把「知识库里可能相关的既有条目」压成一小段，附在请求**末尾**。
 *
 * 为什么需要它（2026-10-13 实测）：digbug 那条会话最近 900 条消息里，kb_* 调用 8 次全是写
 * （kb_upsert / kb_link），**一次读都没有**。库里有 300+ 条节点，实际上只写不读 —— 能不能"想起来"
 * 完全取决于模型自己是否记得一个碎片词去 kb_query。用户的原话：
 * 「模型要在 KB 里找到这个东西，前提是模型还记得这个东西的一点碎片记忆……上下文召回不是很聪明。」
 *
 * 三个形态约束：
 *  · **附在末尾**：不改历史、不改系统提示词。前缀缓存按头部判定，动头部等于每轮全价重算
 *    （docs/context-and-caching.md 实测：改头部 0% 命中，附末尾 74%）。
 *  · **小**：最多 5 条、1200 字符。召回是提示，不是搬运 —— 用户要的正是"不用把对话记录全塞进去"。
 *  · **不确定就闭嘴**：问候、太短的话、查不到、分数低于地板 —— 一个字节都不加。
 */

/** 最多几条。再多的边际价值很低，而每一条都在每一轮里重复付 token。 */
export const AUTO_RECALL_LIMIT = 5;
/** 整块的字符上限（含抬头）。 */
export const AUTO_RECALL_MAX_CHARS = 1200;
/** 短于这个长度的话不值得去查（"好""嗯""继续"）。 */
const MIN_QUERY_CHARS = 12;
/** 低于这个分数的命中不算"可能相关"。 */
const SCORE_FLOOR = 0.3;
/** 每条正文的摘要长度。 */
const SNIPPET_CHARS = 160;

const GREETING = /^(你好|您好|hi|hello|hey|谢谢|多谢|thanks|thank you|在吗|早安|早|晚安|好的|ok|okay|收到)[!！。.，,～~ ]*$/i;

/** 这句话值不值得去库里找。问候与太短的话不值 —— 实测"你好"那条本来就已经是最贵的一轮。 */
export function shouldAutoRecall(text: string): boolean {
  const s = String(text ?? '').trim();
  if (s.length < MIN_QUERY_CHARS) return false;
  return !GREETING.test(s);
}

/** 只用到引擎的一小块（便于测试替身，不必造真库）。 */
export interface RecallSource {
  query(q: string): {
    nodes: Array<{ id: string; title: string; content: string; kind?: string }>;
    traces: Array<{ finalScore?: number; activationLevel?: number; groupPath?: string[] } | undefined>;
  };
}

const sniff = (s: string, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * 渲染这一轮的召回块；一条都不够格时返回 **空串**（调用方据此一个字节都不加）。
 * 查询抛错也返回空串 —— 召回失败绝不许弄坏一轮对话。
 */
export function renderAutoRecall(source: RecallSource, text: string, maxChars = AUTO_RECALL_MAX_CHARS): string {
  if (!shouldAutoRecall(text)) return '';
  let r: ReturnType<RecallSource['query']>;
  try {
    r = source.query(text);
  } catch {
    return '';
  }
  const lines: string[] = [];
  const nodes = r?.nodes ?? [];
  const traces = r?.traces ?? [];
  for (let i = 0; i < nodes.length && lines.length < AUTO_RECALL_LIMIT; i++) {
    const n = nodes[i];
    if (!n) continue;
    const t = traces[i];
    const score = Number(t?.finalScore ?? t?.activationLevel ?? 1);
    if (!Number.isFinite(score) || score < SCORE_FLOOR) continue;
    const group = (t?.groupPath ?? [])[0] ?? '';
    lines.push(`- ${group ? `[${group}] ` : ''}${sniff(n.title, 90)}（score ${score.toFixed(2)}）：${sniff(n.content, SNIPPET_CHARS)} [Node: ${n.id}]`);
  }
  if (!lines.length) return '';
  const head = '【自动召回】知识库里可能相关的既有条目（结构共振排序，未必对——与你无关就当没看见）：';
  const tail = '（这是本轮的临时提示，不进历史，也不等于你已经查过库；不够就 kb_query 换词再查。）';
  let body = lines.join('\n');
  const room = maxChars - head.length - tail.length - 2;
  if (body.length > room) body = body.slice(0, Math.max(0, room));
  return `${head}\n${body}\n${tail}`;
}
