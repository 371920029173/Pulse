/**
 * 上下文天花板救援：纯函数核。
 *
 * 背景（用户报的问题）：会话长到超过模型窗口后，`messagesForRequest()` 仍然把整段历史原样发出，
 * 模型端返回 4xx，`failTurn()` 归成"模型端错误"，而重试必然同样失败、历史只会更长 —— 这条会话
 * 从此不可用。
 *
 * 修法的形状由 `docs/context-and-caching.md` 定死，那是本仓库的权威设计：
 *
 *   - **压缩，不是裁剪。** 提示缓存是前缀缓存：从头部裁一块，序列在裁点之后立刻分叉，之后每一轮
 *     的命中率都是 0%（每轮全价），而且模型再也看不到早先的轮次。压缩（把较早的一整段换成一份
 *     摘要）只在压的那一次丢缓存。
 *   - **摘要冻结、压缩点固定。** 摘要生成一次就不再重算，压缩点选定后不再漂移 —— 否则每轮都在改
 *     前缀，等于每轮全价。
 *   - **盘上的记录一条不动。** 压缩只改"发给模型的那一份"；`historyForDisk()` 仍是完整转写。
 *     `compaction.test.ts` 钉着这一条（长记录完整发出、后续轮次只追加）。
 *
 * 这个文件只放能离线复现的纯函数：同样的输入永远给同样的输出。压缩点漂一次就是一次全价请求，
 * 所以"什么时候切、切在哪"必须是可以被测试钉住的，而不是跑起来才知道的。
 */
import type { LLMMessage } from '@she/shared';

/**
 * 字符 → token 的换算比。3.47 是实测值（`docs/context-and-caching.md`：19.5k 字符 ≈ 5.6k
 * tokens）。用 4 会把请求估小，而估小的方向正好是"该压的时候不压"。
 */
export const CHARS_PER_TOKEN = 3.47;

/** 摘要取样最多读多少字符原文。摘要是**有界的**，否则生成摘要的那次调用自己会溢出。 */
export const DIGEST_SOURCE_MAX_CHARS = 48_000;

/** 摘要正文上限。它是新前缀的一部分，不能长成新的问题。 */
export const DIGEST_MAX_CHARS = 8_000;

/** 摘要短于这个长度就不算数，退回机械提取。 */
export const MIN_DIGEST_CHARS = 40;

/** 压缩后希望留在上下文里的最近对话量（token），按窗口的 5% 取，夹在下面两个数之间。 */
export const KEEP_WINDOW_SHARE = 0.05;
export const MIN_KEEP_TOKENS = 4_000;
export const MAX_KEEP_TOKENS = 8_000;

/**
 * 压缩摘要那条消息的开头。导出成常量是因为**分类账要用它**：一眼看出"这一条是摘要，不是对话"，
 * 比按长度或角色去猜可靠 —— 摘要恰好也是 user 角色。
 */
export const DIGEST_MARK = '[压缩记录]';

/** 一条已经冻结的压缩记录。落盘在会话目录里，重启后复用。 */
export interface CompactionState {
  v: 1;
  /**
   * 摘要覆盖了历史里从 0 开始的多少条消息。它**同时就是切点下标**（`head = history.slice(0, covered)`），
   * 所以恢复时先用它定位、再退回指纹匹配 —— 见 `compactionCut()` 里为什么是这个顺序。
   */
  covered: number;
  /** 压掉的是哪一段（0 … coveredTo）、压的那一刻还留了多少条 —— 供"压缩日志"读。 */
  coveredFrom?: number;
  /** 被折叠那一段里「像该记住的」候选（压缩时算一次、冻在这里随记录落盘；digestMessage 只印不重算）。 */
  kbCandidates?: KbCandidate[];
  coveredTo?: number;
  keptCount?: number;
  /**
   * 摘要后面第一条消息的指纹。
   *
   * 存指纹而不是只存下标：下标是**相对**的。会话从盘上恢复时 `setHistory()` 会跑一遍
   * `repairApiMessages()`，它可能丢掉不合法的行，于是同一个下标指向了另一条消息。指纹让"边界
   * 是否还对得上"变成一个可判定的问题 —— 对不上就不复用这份摘要，而不是把摘要套在错误的边界上。
   */
  nextFingerprint: string;
  /** 冻结的摘要正文。这一串之后每轮原样重发，不再重算。 */
  digest: string;
  /** 摘要哪来的。要显示给用户 —— 机械摘要不该看起来像模型总结。 */
  source: 'model' | 'extractive';
  /**
   * 被折叠的那一段原文落在哪（工作区相对路径）。null / 缺省 = 没能落盘。
   *
   * 有了它，压缩就不再等于"永久丢失"：摘要抬头把路径写给模型，具体某一行的输出、某条报错原文
   * 都能用 `fs_read` 按需取回。`tool-output.ts` 对超预算的工具结果早就在这么做了（存盘 + 注解
   * 给路径），压缩这一层此前缺的正是同一个保证。
   */
  sourcePath?: string | null;
  /**
   * 可以拿来把这一段找回来的串（`retrievalAnchors`）。和摘要一样**冻结**：算一次、写进状态、之后
   * 逐字节重发。空数组与缺省都是"没抽出可用的锚点"，抬头就不印那一行（印一个空表比不印更坏）。
   */
  anchors?: string[];
  /** ISO 时间。 */
  at: string;
  /** 触发原因（阈值 / 模型端溢出 / 手动），进状态行与日志。 */
  reason: string;
  /** 压缩前后估算的提示词 token，用来对账"这次救援省了多少"。 */
  beforeTokens: number;
  afterTokens: number;
  /**
   * 压缩之后那一**次**请求实际付掉的未命中（缓存未命中）token 数。
   *
   * 这是这次压缩真正的代价：摘要改了前缀，从改的那一点起，整段前缀要按未命中价重算一次。数字来自
   * provider 报回来的 usage（`cache_miss_tokens`），不是我们估的 —— 估出来的代价没有说服力。
   * `null` = 还没量到（provider 不报缓存拆分，或者还没发出压缩后的第一个请求）。
   */
  paidTokens?: number | null;
  /** 压缩之后到下一次压缩之间，一共发了几次请求（省下的量按"每次请求都省"累计）。 */
  rounds?: number;
}

export interface TokenEstimate {
  chars: number;
  tokens: number;
}

const charsOf = (v: unknown): number => (typeof v === 'string' ? v.length : 0);

/** 一条消息里所有占 token 的文本体量（不含图片字节 —— 图片按路径发送，见 `chat()`）。 */
export function messageChars(msg: LLMMessage): number {
  let n = charsOf(msg.content) + charsOf(msg.tool_call_id);
  if (msg.reasoning) n += charsOf(msg.reasoning);
  for (const tc of msg.tool_calls ?? []) {
    n += charsOf(tc.function?.name) + charsOf(tc.function?.arguments);
  }
  return n;
}

/**
 * 字符 → token。
 *
 * `charsPerToken` 默认是先验常量（3.47，实测值），但**这个数字可以按真实用量校准**
 * （`calibrateCharsPerToken`）：换模型或换分词器就会变，而它是"什么时候压"的唯一输入。一个偏小
 * 的换算比会算出偏大的 token 数 —— 也就是压得偏早，安全但白花钱；反过来就会撞墙。
 */
export function estimateTokens(chars: number, charsPerToken = CHARS_PER_TOKEN): number {
  const ratio = Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : CHARS_PER_TOKEN;
  return Math.ceil(Math.max(0, chars) / ratio);
}

/**
 * 用真实用量把"字符 → token"的换算比校回来。
 *
 * 3.47 是一次实测的常量（docs/context-and-caching.md），文档里原本写着"换模型或换分词器要人工重
 * 测"。这个仓库已经有更好的东西：每轮请求的 usage 里就有模型报回来的真实 `prompt_tokens`
 * （run trace 的 `request` 事件也在记它），而我们**完全知道自己发了多少字符**。两者一比就是这一次
 * 的换算比 —— 于是这件事从"人工重测"变成"自己量、自己记"。
 *
 * 三条纪律：
 *   1. **样本不足就不动**（少于 `minSamples` 用先验）：单次请求的取整误差在 1% 量级，样本少时中位数
 *      本身不可信。
 *   2. **夹紧 [2.5, 5.0]**：落在这个区间之外的换算比几乎一定是采样出了错（把别的请求的 tokens 记到
 *      了这一条上），而一个荒唐的换算比会让整套阈值失控。
 *   3. 取**中位数**而不是均值：一次异常样本不该把换算比整体拉走。
 */
export function calibrateCharsPerToken(
  samples: readonly number[],
  prior = CHARS_PER_TOKEN,
  minSamples = 3,
): number {
  const ok = samples.filter((n) => Number.isFinite(n) && n > 0);
  if (ok.length < minSamples) return prior;
  const sorted = [...ok].sort((a, b) => a - b);
  const mid = sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  return Math.min(5, Math.max(2.5, Number(mid.toFixed(3))));
}

/**
 * 一次请求的估算大小。
 *
 * `overheadChars` 是系统提示词 + 工具表：它们不在 messages 里，但和消息**一起**决定这次请求会
 * 不会被拒。漏掉它们会让估算系统性偏小，而偏小的方向正好是"该压的时候不压" —— 实测这两项
 * 12.8k tokens 量级（40k 窗口的三分之一），不是可以忽略的零头。
 */
export function estimateRequest(
  messages: readonly LLMMessage[],
  overheadChars = 0,
  charsPerToken = CHARS_PER_TOKEN,
): TokenEstimate {
  let chars = overheadChars;
  for (const m of messages) chars += messageChars(m);
  return { chars, tokens: estimateTokens(chars, charsPerToken) };
}

/** 一条消息的指纹：角色 + 开头一段 + 首个工具名。改一个字符就变，所以能认出"边界那条换了"。 */
export function fingerprint(msg: LLMMessage | undefined): string {
  if (!msg) return '';
  const head = typeof msg.content === 'string' ? msg.content.slice(0, 160) : '';
  const firstCall = msg.tool_calls?.[0]?.function?.name ?? '';
  return `${msg.role}:${head}:${firstCall}`;
}

/**
 * 这一条错误是不是"提示词太长"。
 *
 * 分类错的两个方向代价不对称，所以这里既要求**命中溢出的说法**，又要求**不是限流/超时**：
 *
 *   - 把溢出当普通错误 → 重试一模一样的请求 → 必然再失败一次，然后 `failTurn` 把会话判死。
 *     这正是用户报的问题。
 *   - 把限流当溢出 → 白白压一次上下文（一次全价缓存未命中 + 丢掉细节），而限流本身重试就好。
 *
 * 只认消息文本而不认状态码：这条路径要能兜住"猜的窗口不对"，而各家对 400/413/422 的用法并不
 * 统一，文本反而是最稳定的那一半。中英文都认，因为服务端文案不归我们管。
 */
export function isContextOverflowError(err: unknown): boolean {
  const text = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (!text) return false;
  // 反例优先：限流/超时/鉴权有自己的处理路径，别把它们拉进压缩。
  if (/rate ?limit|too many requests|429|quota|timed? ?out|econnreset|enotfound|unauthor|invalid api key|401|403/.test(text)) {
    return false;
  }
  return [
    /context[_ -]?length[_ -]?(exceeded|limit|error)/,
    /maximum context length/,
    /context window/,
    /reduce the length of the (messages|prompt)/,
    /prompt is too long/,
    /(input|prompt|messages?) (is )?too (long|large|big)/,
    /too many tokens/,
    /tokens in your (prompt|message|request)/,
    /exceeds? (the )?(maximum |model'?s )?(context|token|input)/,
    /*
     * 中文的语序有两种，各写一条：服务端要么说"上下文长度超出上限"（描述语在前），要么说
     * "超出模型窗口"（描述语在后）。只写后者会漏掉第一批 —— 而漏掉的后果正是用户报的那个问题：
     * 会话一到上限就不可用。
     */
    /(上下文|提示词|输入|对话).{0,8}(超出|超过|超长|过长|太大)/,
    /(超出|超过).{0,6}(上下文|长度|窗口|上限)/,
  ].some((re) => re.test(text));
}

/** 压缩后要保留的最近对话量（token）。`keepScale` 让"压过一次还是超"的那一次保留更少。 */
export function keepTokensFor(windowTokens: number, keepScale = 1): number {
  const base = Math.min(MAX_KEEP_TOKENS, Math.max(MIN_KEEP_TOKENS, Math.round(windowTokens * KEEP_WINDOW_SHARE)));
  return Math.max(MIN_KEEP_TOKENS / 2, Math.round(base * keepScale));
}

/**
 * 切点选在哪儿：返回切点下标 `cut`，即将被摘要的是 `history.slice(0, cut)`，保留的是 `history.slice(cut)`。
 *
 * **切点必须落在 assistant 消息上**，这不是审美问题，是接口约束：摘要以 user 角色插进去
 * （见 `digestMessage`），而 Anthropic 的 messages 要求首条非系统消息是 user 且 user/assistant
 * 交替（`anthropic.ts` 直接透传，不做合并）。切在一条 user 消息上会得到连续两条 user，请求当场
 * 不合法 —— 那正好是"救援代码自己把会话弄坏了"。切在 assistant 上还顺带保证 `tool_calls` 与
 * 它的结果不被切开。
 *
 * 目标是保留最近 `keepTokens` 量级：从尾部往前累加到达标的位置之后，**向前**找最近的 assistant
 * （尾巴比目标小一点，安全方向）。这一段里找不到 assistant（末尾是一串工具结果和用户消息）时
 * 才往回找最后一个 assistant（尾巴略大于目标，但仍是合法边界）。
 *
 * 返回 -1 表示"这次切不动"：历史太短、或者压根没有可用的边界。调用方要如实说压不动，不能假装压过。
 */
export function chooseCutIndex(history: readonly LLMMessage[], keepTokens: number): number {
  // 太少的一条历史没有可摘要的东西，硬切等于把仅有的上下文也换成摘要。
  if (history.length < 4) return -1;
  let acc = 0;
  let i = history.length - 1;
  for (; i >= 0; i--) {
    acc += messageChars(history[i]);
    if (estimateTokens(acc) >= keepTokens) break;
  }
  for (let j = Math.max(1, i); j < history.length; j++) {
    if (history[j].role === 'assistant') return j;
  }
  for (let j = Math.min(i, history.length) - 1; j >= 1; j--) {
    if (history[j].role === 'assistant') return j;
  }
  return -1;
}

/** 把要被摘要的那一段渲染成文本，供模型或机械提取使用。有界，确定性。 */
export function digestSourceText(head: readonly LLMMessage[], maxChars = DIGEST_SOURCE_MAX_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (const m of head) {
    const body = typeof m.content === 'string' ? m.content : '';
    const label = m.role === 'tool' ? `工具结果(${m.name ?? 'tool'})` : m.role;
    const calls = m.tool_calls?.length
      ? ` [调用 ${m.tool_calls.map((tc) => tc.function?.name ?? '?').join(', ')}]`
      : '';
    const line = `${label}${calls}: ${body}`;
    if (used + line.length > maxChars) {
      lines.push(`${label}${calls}: ${body.slice(0, Math.max(0, maxChars - used))}…`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * 机械摘要：模型写不出来时的兜底。
 *
 * 有意做成**确定性的**（同样的输入给同样的字节）：它会被冻结进前缀，而后缀每轮都在变，所以
 * "差不多就行"的随机摘要等于每题改一次前缀。它也不假装是模型总结 —— `source` 会写进抬头，
 * 用户在界面上看得出这一份是机械折叠的。
 *
 * 逐条列角色的写法是刻意的：这一份要在模型看不见原文之后替原文说话，"谁说了什么、有哪些工具
 * 调用"比浓缩成一段话更不容易骗人。图片不进摘要（无法文本化），抬头里点名了这一点。
 */
export function summarizeExtractively(head: readonly LLMMessage[], maxChars = DIGEST_MAX_CHARS): string {
  const out: string[] = [];
  let used = 0;
  for (const [idx, m] of head.entries()) {
    const body = (typeof m.content === 'string' ? m.content : '').replace(/\s+/g, ' ').trim();
    const calls = m.tool_calls?.length
      ? `[调用 ${m.tool_calls.map((tc) => tc.function?.name ?? '?').join(', ')}] `
      : '';
    const line = `${idx + 1}. ${m.role === 'tool' ? '工具结果' : m.role}：${calls}${body.slice(0, 400)}`;
    if (used + line.length > maxChars) {
      out.push(`…（还有 ${head.length - idx} 条更早的记录未列入）`);
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

/**
 * 机械摘录：**用户说过的每一句各留一段原文**。
 *
 * 摘要（模型写的）是叙事性的，具体的事实 —— 编号、暗号、路径、数字 —— 会在改写里被抹平。这不是猜的，
 * 是量出来的：8 条"记住这一条：KEY-n 是 ALPHA-nnnn"分散埋在填充里，压过一次之后**模型摘要里一条都没
 * 保住**（0/8），答复里只活下来平均 2/8（`scripts/context-survival-probe.mjs`，deepseek-flash）。
 *
 * 所以这里不猜"哪一条重要"，只用一条**结构性**的规则：用户说过的话是这个会话里唯一不可再生的东西
 * （助手与工具的输出都能重跑、能再读，用户的要求不能）。每人留一段开头，就有机会把事实留下。
 *
 * 有界：最多 `maxRows` 条、每条 `perRow` 字符 —— 摘要是新前缀的一部分，它自己不能长成新的问题。
 */
export function userLinesExcerpt(head: readonly LLMMessage[], perRow = 120, maxChars = 2400): string {
  const users = head.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  if (!users.length) return '';
  /*
   * **每人留一小段，不做取样。**
   *
   * 第一版是按"每 N 条挑一条"来控体积，实测直接失效：事实与长填充在真实序列里交错、还有重复，隔一条
   * 挑一条挑到的全是填充 —— 摘要里只带进了 4 条事实里的 1 条。而这一段的全部意义就是"用户说过的每句话
   * 都别丢"，所以宁可每人只留 120 字符，也不漏人；真的还是超了就在末尾说清漏了几条（不装作完整）。
   */
  const out: string[] = [];
  let used = 0;
  let included = 0;
  for (const m of users) {
    const line = `- ${String(m.content).replace(/\s+/g, ' ').trim().slice(0, perRow)}`;
    if (used + line.length + 1 > maxChars) break;
    out.push(line);
    used += line.length + 1;
    included += 1;
  }
  if (included < users.length) out.push(`…（另有 ${users.length - included} 条用户消息未列入）`);
  return out.join('\n');
}

/** 粘进请求的那条摘要消息。**角色是 user**：见 `chooseCutIndex()` 里关于交替的说明。 */
export function digestMessage(
  state: Pick<CompactionState, 'digest' | 'covered' | 'source' | 'at' | 'sourcePath' | 'anchors' | 'kbCandidates'>,
): LLMMessage {
  const who = state.source === 'model' ? '模型总结' : '机械折叠';
  /*
   * 抬头必须**一次写成、之后逐字节不变**（它在新前缀里）：所以路径只在压缩那一刻算一次，写进
   * state 落盘，之后每轮原样重发。落盘失败时说的是"不在摘要里"（弱化到原来的说法），而不是给一个
   * 读不到的路径 —— 指向不存在的东西比不说更坏。
   */
  const where = state.sourcePath
    ? `被折叠的 ${state.covered} 条**原文**已存到 ${state.sourcePath}（用 fs_read 加 startLine/endLine 分段读，不要为了看全量重跑整段对话）。`
    : '图片与工具输出的完整原文不在摘要里，需要时可以让工具重新取一次。';
  /*
   * 锚点只在**抽到了**的时候才印。空表被印成"可以用这些找：（）"是在暗示有线索，而实际什么都没有；
   * 一条列得出来的锚点则是一条真的能干的事（grep 它、fs_read 它、kb_query 它）。
   */
  /*
   * 锚点**只在原文真的落了盘**时才印：它们的存在意义是"按这个串去那个文件里找"，没有那个文件，
   * 一串串锚点就只是装饰（而装饰会被读成线索）。落盘失败时抬头退回上一句"原文不在摘要里"。
   */
  const anchors = state.sourcePath && state.anchors?.length
    ? `\n要找细节时，这些串在原文里真的出现过：${state.anchors.map((a) => `\`${a}\``).join('、')}`
      + (state.anchors.some((a) => a.includes('/')) ? '（带路径的可以直接 kb_query 按组查）。' : '。')
    : '';
  /*
   * 候选块：**只在抽到了才印**（同锚点那条纪律 —— 空表会被读成"有线索"）。
   * 它说的是"这几行现在只活在这份摘要与原文里"，并要求先查证再补记 —— 不替模型写库，
   * 因为自动写进 KB 是不可逆的（要 retire 才能撤），而"该不该记"只有模型看着上下文能判。
   */
  const harvest = state.kbCandidates?.length
    ? `\n\n另外：被折叠的那一段里，下面这几行看着是"该记住的"（决定 / 约定 / 踩坑 / 环境），`
      + `现在只活在这份摘要与原文里。请**先逐条 \`kb_query\` 查证**，查不到的用 \`kb_upsert\` 补记`
      + `（一条一个节点，写清出处与出处那条的下标）：\n`
      + state.kbCandidates
        .map((c) => `- [${c.why} · 第 ${c.at + 1} 条 ${c.role}] ${c.title}`)
        .join('\n')
    : '';
  return {
    role: 'user',
    content:
      `[压缩记录] 本次对话较早的 ${state.covered} 条记录因为上下文接近模型上限，已被压缩成下面这份摘要`
      + `（${who}，${state.at}）。${where}${anchors}\n\n`
      + harvest
      + state.digest,
  };
}

/**
 * 请求的 token 花在哪儿了 —— 分类账。
 *
 * 对齐 Cursor 的上下文分类账（`cursor.com/docs/agent/prompting`）：「点开上下文环，按类别看总量」。
 * 差别是它的分类里有规则的技能/MCP/子代理目录，那些在本仓库是**系统提示词的一部分**，所以这里
 * 归到 `system` 一类里（而不是假装能分开：分开的代价是另一套注入记账，收益只是面板上多一行）。
 *
 * 为什么值得有：`usedTokens` 只回答"还有多远"，而"是谁吃掉的"才是下一步该动的地方 ——
 * 摘要压了、工具结果却没长，和反过来，是两种完全不同的病。
 *
 * 各类之和与 `total` 允许有**每个类别 1 token 的取整差**：每类各自向上取整，合起来可能比总量多
 * 几 token。判据按这个容差比，而不是假装它们必然相等。
 */
export interface ContextBreakdown {
  /** 系统提示词（本仓库里含规则、技能索引、知识库提示、自评块）。 */
  system: number;
  /** 工具表的 JSON schema。它不在 messages 里，但每次请求都要付。 */
  tools: number;
  /** 已冻结的压缩摘要（`DIGEST_MARK` 那一条）。 */
  digest: number;
  /** 工具结果（role=tool）。 */
  toolResults: number;
  /** 对话正文：user / assistant 的文本与推理，不含工具结果与摘要。 */
  conversation: number;
  /** 合计。 */
  total: number;
}

export function breakdownRequest(
  messages: readonly LLMMessage[],
  toolTableChars = 0,
  charsPerToken = CHARS_PER_TOKEN,
): ContextBreakdown {
  let systemChars = 0;
  let digestChars = 0;
  let toolResultChars = 0;
  let conversationChars = 0;
  for (const m of messages) {
    const n = messageChars(m);
    if (m.role === 'system') systemChars += n;
    else if (m.role === 'tool') toolResultChars += n;
    else if (typeof m.content === 'string' && m.content.startsWith(DIGEST_MARK)) digestChars += n;
    else conversationChars += n;
  }
  const totalChars = systemChars + toolTableChars + digestChars + toolResultChars + conversationChars;
  return {
    system: estimateTokens(systemChars, charsPerToken),
    tools: estimateTokens(toolTableChars, charsPerToken),
    digest: estimateTokens(digestChars, charsPerToken),
    toolResults: estimateTokens(toolResultChars, charsPerToken),
    conversation: estimateTokens(conversationChars, charsPerToken),
    total: estimateTokens(totalChars, charsPerToken),
  };
}

/**
 * 从被折叠的那一段里抽出"能把它找回来"的锚点。
 *
 * 摘要是有损的，而模型之后要的多半是一个**具体的东西**："刚才那条报错原文"、"我改过哪个文件"、
 * "那次 shell 到底跑了什么"、"哪个知识库组"。给它一串**原文里真的出现过**的串，加上抬头里那个
 * 原文路径，它就能用 grep / fs_read 精确取回 —— 这比再写一段更细的摘要便宜得多，也不会骗人。
 *
 * 四类，都是本仓库自己长出来的东西：文件路径（取回的第一入口）、命令的第一个词（"跑过什么"按可执行
 * 名找就够）、报错与失败标记（下一轮最常要的原文）、知识库组路径（可以直接 kb_query 按组查）。
 *
 * 确定性：同样的段给同样的列表（按出现次数降序；同频次时**较晚出现的优先** —— 折叠点之前的最后
 * 几条，最可能就是下一步要引用的东西；最后按字典序兜底）—— 摘要要冻结进前缀，一个每次重排的锚点表
 * 等于每轮改前缀。
 */
/** 一条「该记住的」候选：在被折叠那一段里的位置 + 一行摘要 + 为什么被挑中。 */
export interface KbCandidate {
  /** 在被折叠的那一段里的下标（0 起），用来回原文核对。 */
  at: number;
  role: string;
  title: string;
  /** 命中了哪几类标记（决定 / 约定 / 踩坑 / 环境）。 */
  why: string;
}

/**
 * 词表刻意短：宁可漏，也不要噪声。压缩记录里塞一堆误报，模型就会连真的那条一起忽略。
 * 四类对应"丢了最疼"的东西：决定（会反复用到）、约定（下次必须照做）、踩坑（会再踩）、
 * 环境（端口 / 路径 / 命令，重查成本高）。
 */
const KB_MARKERS: Array<[RegExp, string]> = [
  [/决定|结论|定下来|就这么办/, '决定'],
  [/约定|规范|一律|必须|不要|禁止|口径|规则/, '约定'],
  [/踩坑|坑|注意|小心|别再/, '踩坑'],
  [/端口|路径|默认|环境变量|目录|命令/, '环境'],
];

/**
 * 从被折叠的那一段里挑出"该记住的"候选。
 *
 * 取舍写在代码里，而不是让模型猜：结构化正文（工具回执那种 JSON）是**数据**不是结论，先排除；
 * 太短的（"好的""收到"）排除；同一条只留一份；有上限 —— 候选块是要被模型读的，不是归档。
 * 排序用「命中类别数 × 100 + 下标」：越靠后说的越可能是当前口径，同分时后出现的优先。
 */
export function kbCandidates(history: readonly LLMMessage[], limit = 6): KbCandidate[] {
  const scored: Array<{ at: number; role: string; title: string; why: string; score: number }> = [];
  history.forEach((m, at) => {
    const content = String(m.content ?? '').trim();
    if (!content) return;
    // 结构化正文是数据，不是"该记住的"。
    if (content.startsWith('{') || content.startsWith('[')) return;
    const hits = KB_MARKERS.filter(([re]) => re.test(content)).map(([, name]) => name);
    if (!hits.length) return;
    const title = content.replace(/\s+/g, ' ').trim();
    if (title.length < 12) return;
    scored.push({
      at, role: m.role, title: title.slice(0, 120), why: [...new Set(hits)].join('/'),
      score: hits.length * 100 + at,
    });
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .sort((a, b) => a.at - b.at)
    .map(({ at, role, title, why }) => ({ at, role, title, why }));
}

export function retrievalAnchors(head: readonly LLMMessage[], max = 10): string[] {
  const seen = new Map<string, { n: number; at: number }>();
  const bump = (raw: unknown, at: number) => {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (s.length < 3 || s.length > 120) return;
    const cur = seen.get(s);
    if (cur) cur.n += 1;
    else seen.set(s, { n: 1, at });
  };
  const EXT = /^[A-Za-z0-9]{1,8}$/;
  const KNOWN = new Set(['ts', 'tsx', 'js', 'mjs', 'cjs', 'json', 'md', 'yml', 'yaml', 'css', 'html', 'py', 'sh', 'bat', 'ps1', 'toml', 'env', 'txt', 'sqlite', 'csv', 'log']);
  head.forEach((m, i) => {
    const text = typeof m.content === 'string' ? m.content : '';
    for (const mt of text.matchAll(/(?:^|[\s("'`\[\]])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8})/g)) bump(mt[1], i);
    for (const mt of text.matchAll(/(?:^|[\s("'\`])[\w@-]+\.([A-Za-z0-9]{1,8})\b/g)) {
      if (KNOWN.has(mt[1].toLowerCase())) bump(mt[0].trim().replace(/^[\s("'\`]/, ''), i);
    }
    for (const mt of text.matchAll(/(?:Error:|DENIED:|exit code: \d+|FAIL\b|failed:)/g)) bump(mt[0], i);
    for (const tc of m.tool_calls ?? []) {
      const name = tc.function?.name ?? '';
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function?.arguments ?? '{}') as Record<string, unknown>; } catch { args = {}; }
      if (name.startsWith('shell')) {
        const cmd = typeof args.command === 'string' ? args.command.trim().split(/\s+/)[0] : '';
        if (cmd && EXT.test(cmd)) bump(cmd, i);
      }
      if (typeof args.groupName === 'string' && args.groupName.includes('/')) bump(args.groupName, i);
    }
  });
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...seen.entries()]
    .sort((a, b) => (b[1].n - a[1].n) || (b[1].at - a[1].at) || byText(a[0], b[0]))
    .slice(0, max)
    .map(([s]) => s);
}

/**
 * 只留下**在原文里真的找得到**的锚点。
 *
 * 锚点表印在摘要抬头里，而那句话是在说"这些串在原文里出现过" —— 那就得真的是这样。核对一遍的
 * 成本是内存里一次 `includes`，收益是这张表不会被读成"线索"却指不到任何东西：索引不许撒谎。
 *
 * 落盘失败时调用方根本不会调它（没有原文可核对，抬头也就不印锚点表）。
 */
export function anchorsIn(text: string, anchors: readonly string[]): string[] {
  if (!text || !anchors.length) return [];
  return anchors.filter((a) => a.length >= 3 && text.includes(a));
}

/**
 * 一条工具结果这一刻允许带进上下文多少字符 —— 按**还剩多少余量**算，不是固定值。
 *
 * 固定 16k 的问题在天花板附近才显出来：一个 16k 字符的结果（≈4.6k token）在 40k 窗口下是九分之一，
 * 在"还剩两千 token"时它就是压死骆驼的那一根 —— 而它到达的那一刻正好是**唯一**能裁它的时刻（裁在
 * 更晚就等于改前缀，见 tool-output.ts）。
 *
 * 规则一句话：**一条结果最多吃掉剩余余量的八分之一**，上限是原来的 16k 字符，下限 800 字符
 * （比这更小的话，命令日志连退出码行都放不下）。所以离天花板远时行为与以前完全一样（16k），近了才收紧。
 */
export function toolResultBudgetChars(usedTokens: number, windowTokens: number, charsPerToken = CHARS_PER_TOKEN): number {
  if (!Number.isFinite(windowTokens) || windowTokens <= 0) return TOOL_RESULT_CAP_CHARS;
  const remainingTokens = Math.max(0, windowTokens - Math.max(0, usedTokens));
  const remainingChars = remainingTokens * (Number.isFinite(charsPerToken) && charsPerToken > 0 ? charsPerToken : CHARS_PER_TOKEN);
  return Math.max(800, Math.min(TOOL_RESULT_CAP_CHARS, Math.floor(remainingChars / 8)));
}

/** 工具结果预算的上限（与 `tool-output.ts` 的 `TOOL_RESULT_CONTEXT_CHARS` 同一个数）。 */
export const TOOL_RESULT_CAP_CHARS = 16_000;

/**
 * 从"太长"的报文里把它自己说的上限读出来。
 *
 * 这是这套机制里唯一一处**能从一次失败里学到东西**的地方：窗口原本是按模型名猜的（可能错，实测
 * 这个端点的真实上限比表里大得多），而模型端的拒绝里通常写着真实数字
 * （`maximum context length is 65536 tokens`）。读到就存下来，之后按它算 —— **猜错一次，不必再猜**。
 *
 * 三条安全线，缺一条都会让这个"学习"变成新的故障源：
 *
 *   1. **只认点名了上下文的数字**。报文里还常有 `max_tokens`、请求 id、端口号。刻意**不**收
 *      "数字 + tokens" 这种泛匹配：`max_tokens: 4096` 完全符合它，而把窗口学成 4096 会让之后每次
 *      会话都在几千 token 处压缩。学不到（返回 undefined）是安全的，学错不是。
 *   2. **范围夹紧 [4096, 1000 万]**。0、1、负数、UUID 片段都不是窗口。
 *   3. 调用方负责"只收比当前更小的值"：比当前窗口还大的"上限"不可能拒掉这个请求，那是误读。
 */
export function windowFromOverflowError(err: unknown): number | undefined {
  const text = err instanceof Error ? err.message : String(err ?? '');
  if (!text) return undefined;
  const patterns = [
    /maximum\s+context\s+length\s*(?:is|of|:|=)?\s*([\d,._]{3,})/i,
    /context\s+length\s+(?:is|of)\s+([\d,._]{3,})/i,
    /context\s+window\s+(?:is|of|is limited to)\s+([\d,._]{3,})/i,
    /context\s+size\s+(?:is|of)\s+([\d,._]{3,})/i,
    /(?:上限|最多)[^\d]{0,10}([\d,._]{3,})/,
    /上下文[^\d]{0,12}([\d,._]{3,})/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const n = Number(m[1].replace(/[,._]/g, ''));
    if (Number.isFinite(n) && n >= 4_096 && n <= 10_000_000) return Math.trunc(n);
  }
  return undefined;
}

/**
 * 这份冻结的压缩记录，现在还能用在哪个切点上。
 *
 * **先用 `covered`，再退回指纹匹配**，顺序不能反。只靠扫描会踩一个真实的坑：指纹是"角色 + 开头
 * 一段"，两条都以"好的"开头的 assistant 消息指纹必然相同，从头扫到的第一个匹配通常更早 —— 于是
 * 本该被折叠的一整段又进了请求（请求比压缩时更大），"压过一次就把阈值抬到 95%"也跟着失效，两轮
 * 之后又压一次，每轮都在改前缀。
 *
 * 退回匹配时取**离记录位置最近**的那一个，而不是第一个：下标漂移的原因是从盘上恢复时
 * `repairApiMessages()` 丢行，漂移是几行的量级，最近的匹配才是原来那条边界。
 *
 * 返回 -1 表示"这份记录用不上了"（历史变了、边界找不到了）：那就重新压一次，而不是把摘要套在
 * 错误的边界上。
 */
export function compactionCut(state: CompactionState | null, history: readonly LLMMessage[]): number {
  if (!state || state.covered < 1 || state.digest.length < MIN_DIGEST_CHARS) return -1;
  const isBoundary = (i: number): boolean => i >= 1 && i < history.length && history[i].role === 'assistant';
  if (isBoundary(state.covered) && fingerprint(history[state.covered]) === state.nextFingerprint) {
    return state.covered;
  }
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 1; i < history.length; i++) {
    if (history[i].role !== 'assistant') continue;
    if (fingerprint(history[i]) !== state.nextFingerprint) continue;
    const d = Math.abs(i - state.covered);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** 把压缩记录套到本次请求上：摘要 + 保留的那一段。没到阈值时调用方根本不会走到这里。 */
export function appliedMessages(
  history: readonly LLMMessage[],
  state: CompactionState | null,
  systemMessage: LLMMessage,
): { messages: LLMMessage[]; applied: boolean } {
  const cut = compactionCut(state, history);
  if (cut <= 0 || !state) return { messages: [systemMessage, ...history], applied: false };
  return { messages: [systemMessage, digestMessage(state), ...history.slice(cut)], applied: true };
}
