/**
 * 一次请求最多能带多少 token —— 这个数字，以及它是**从哪来的**。
 *
 * 在自动压缩出现之前，代码里没有任何地方知道模型的窗口：`messagesForRequest()` 把整段历史原样
 * 发出，唯一的"上限"就是模型端自己。于是历史一超过窗口，模型端返回 4xx，重试必然同样失败、而
 * 历史只会更长 —— 这条会话从此不可用（`failTurn` 当时把它归成"模型端错误"，还建议"再说一次"）。
 *
 * 三个来源，按可信度与可修改性排序：
 *
 *   1. `config` —— 用户在设置页填的（落盘为 `llm.contextWindow`）。填错也能改回来，是最强的一个。
 *   2. `env`    —— `SHE_CONTEXT_WINDOW`。容器/脚本里定，不经过设置页。
 *   3. `model`  —— 按模型名认出家族的公开窗口。
 *   4. `default`—— 都不匹配时的保守值。
 *
 * **猜大和猜小的代价不一样，而默认值取的是保守那一侧。** 猜大了是"该压的时候不压"，那时还有
 * 模型端拒绝兜底（`isContextOverflowError` 那条路，压缩后重发）；猜小了是"过早压缩"：摘要改写
 * 前缀要付一次缓存未命中，而且被折叠的细节再也回不到模型眼前。所以默认值偏小、而不是偏大，
 * 并且**来源永远跟着数字一起回给调用方** —— 一个不知道从哪来的上限，用户没法怀疑它，也就没
 * 法修它。
 */

/**
 * 认不出模型名时的取值。
 *
 * 128k 是当下主流服务端窗口的下沿（Claude 200k、GPT-4o 128k、DeepSeek 128k、Qwen 128k），
 * 取它意味着"对绝大多数模型不会过早压缩"，同时"对小窗口不至于完全不管"。
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 数字的来历。接口与日志都要点名，用户才知道去哪儿改。
 *
 * `learned` 是唯一一条**不是猜的**：模型端在拒绝一次超长请求时通常会把真实上限写在报文里
 * （见 `windowFromOverflowError`），我们把它记下来。猜错一次，之后就不必再猜。
 */
export type ContextWindowSource = 'config' | 'env' | 'learned' | 'model' | 'default';

export interface ContextWindowInfo {
  tokens: number;
  source: ContextWindowSource;
  /** 人话说明这个数字从哪来，进日志、状态行与接口。 */
  detail: string;
}

/**
 * 按模型名认窗口。
 *
 * **顺序有意义**：第一个匹配到的赢，所以更窄的族写在更宽的族前面（`gpt-3.5` 必须排在
 * `gpt-4` 那一类之前，否则 `gpt-3.5-turbo` 会拿到 128k）。名字里可能带厂商前缀
 * （`openai/gpt-4o`）或日期后缀（`claude-3-5-sonnet-20241022`），所以匹配一律是**子串**，
 * 不做等值比较。
 */
const FAMILIES: ReadonlyArray<{ re: RegExp; tokens: number; label: string }> = [
  { re: /gemini/i, tokens: 1_000_000, label: 'Gemini' },
  { re: /claude/i, tokens: 200_000, label: 'Claude' },
  { re: /gpt-3\.5/i, tokens: 16_000, label: 'GPT-3.5' },
  { re: /gpt-4|gpt-5|chatgpt|\bo[1-9]\b/i, tokens: 128_000, label: 'GPT-4/5 与 o 系列' },
  /*
   * DeepSeek 要分开写：**厂商模型页点名的**新模型是 1M（deepseek-flash = DeepSeek-V4.1-Flash、
   * deepseek-v4-pro，2026-10-06 由用户提供），而老的 deepseek-chat / deepseek-reasoner 是 64k–128k。
   * 一条笼统的 /deepseek/ 只能二选一，而两个方向都错得起：给老模型 1M 会"该压不压"（那时靠模型端
   * 拒绝兜底），给新模型 128k 会白白早压（一次缓存未命中 + 细节提前离开上下文）。所以窄的写在宽的前面。
   *
   * 这也顺带说明这张表的定位：它只是**没人告诉过我们真实值时的猜测**。真实值有三条来源 ——
   * 设置里的 llm.contextWindow、SHE_CONTEXT_WINDOW、以及模型端拒绝时报出来的那个数（learned），
   * 三条都优先于这里。
   */
  { re: /deepseek-(flash|v4)/i, tokens: 1_000_000, label: 'DeepSeek V4 系列（厂商规格 1M）' },
  { re: /deepseek/i, tokens: 128_000, label: 'DeepSeek（早于 V4 的型号，取保守值）' },
  { re: /qwen|tongyi/i, tokens: 128_000, label: 'Qwen' },
  { re: /glm|chatglm/i, tokens: 128_000, label: 'GLM' },
  { re: /kimi|moonshot/i, tokens: 128_000, label: 'Kimi' },
  { re: /grok/i, tokens: 128_000, label: 'Grok' },
  { re: /llama/i, tokens: 128_000, label: 'Llama' },
  { re: /mistral|mixtral/i, tokens: 32_000, label: 'Mistral' },
];

/** `SHE_CONTEXT_WINDOW` 这类字符串：认正整数；`0` 与写坏的值都表示"没填"。 */
export function parseContextWindowValue(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined;
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return n > 0 ? Math.trunc(n) : undefined;
}

/**
 * 解析这一次请求的上限。
 *
 * 优先级在文档头部；这里只强调一条容易被写错的边界：**配置里填 0 是"回到自动识别"**，不是
 * "窗口是 0"。用 `if (configured)` 判断会把 0 当成"没填"，那样这一格就永远关不掉自动识别了 ——
 * 用户填 0 想回到识别，结果窗口停在旧值上，而设置页显示的是 0。所以判断的是范围（`> 0`），
 * 不是真值。
 */
export function resolveContextWindow(input: {
  configured?: number;
  envValue?: string;
  /**
   * 上一次被模型端拒绝时，它自己在报文里给出的上限（`windowFromOverflowError` 读到的）。
   * 按 provider/model@baseUrl 记，换模型不会串用。
   */
  learned?: number;
  model: string;
}): ContextWindowInfo {
  const fromConfig = parseContextWindowValue(input.configured);
  const fromEnv = parseContextWindowValue(input.envValue);
  const learned = parseContextWindowValue(input.learned);
  const explicit = fromConfig ?? fromEnv;
  /*
   * 显式设置与"学到的"冲突时取**更小的那个**：一次真实的拒绝是证据，而设置是一个声明；冲突时按
   * 证据走（压早一点）比按声明走（再撞一次）好。两个数都写进 detail，用户看得见分歧。
   */
  if (explicit !== undefined && learned !== undefined && learned < explicit) {
    return {
      tokens: learned,
      source: 'learned',
      detail: `模型端拒绝时给出的上限（${learned}，比设置里的 ${explicit} 小，按证据走）`,
    };
  }
  if (fromConfig !== undefined) {
    return { tokens: fromConfig, source: 'config', detail: '设置里的「上下文窗口」指定' };
  }
  if (fromEnv !== undefined) {
    return { tokens: fromEnv, source: 'env', detail: 'SHE_CONTEXT_WINDOW 指定' };
  }
  if (learned !== undefined) {
    return { tokens: learned, source: 'learned', detail: `模型端拒绝时给出的上限（${learned}，上次撞墙时记下的）` };
  }
  const name = input.model || '';
  for (const f of FAMILIES) {
    if (f.re.test(name)) {
      return { tokens: f.tokens, source: 'model', detail: `按模型名识别（${f.label} 家族）` };
    }
  }
  return {
    tokens: DEFAULT_CONTEXT_WINDOW,
    source: 'default',
    detail: '保守默认（模型名不在已知家族里，填对窗口能少付几次压缩）',
  };
}

/** 一行说明，日志与状态行共用同一份措辞（两处各写一遍就会分叉）。 */
export function describeContextWindow(info: ContextWindowInfo): string {
  return `${info.tokens} tokens（${info.detail}）`;
}
