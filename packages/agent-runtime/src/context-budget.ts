/**
 * 按用户输入的 token 定价，决定这一轮该往哪一侧省钱。
 *
 * ## 为什么这个文件存在
 *
 * 用户要的是"输入当前 token 定价 → 据此分配最优压缩逻辑 → 取到最小消耗"。所以定价必须是**真的
 * 参与决策**的输入，而不是显示用的标签：同样的会话、同样的长度，输入贵和输出贵该给出不同的建议。
 * 这个文件里没有一行读时钟、读文件或读环境变量 —— 它只跟 (定价, 用量, 用户选的档位) 有关，所以
 * 算术可以在没有模型的情况下测。
 *
 * ## 和"不许丢历史"那条既有决策的关系
 *
 * `__tests__/compaction.test.ts` 钉着一条刻意的决定：长记录**完整发出**，**什么都不删**。理由是
 * 实测教训 —— 早期版本把超过 ~120k 的对话换成一个 8k 摘要，文件继续长大而模型再也看不到早期轮次，
 * 会话可用长度就卡死了。丢了上下文，模型得重新找，往往**更贵**。
 *
 * 这份代码不去推翻它，而是把它变成这个模块的一条不变量：
 *
 *   - 会**删掉用户内容**的杠杆（历史压缩）默认不参与。它要用户在设置页显式打开
 *     （`allowHistoryReduction`），而且只有档位到 `aggressive` 才真的动手。
 *   - 其余三个杠杆都只影响"这一轮给模型看多少"，不动磁盘上的任何一条记录。
 *
 * 用户要求的免责声明也因此是**真的**："尽量为您减少开支，但不保证不会使您的开支增加" —— 压缩会
 * 让模型为了补上被省掉的上下文而多跑几轮，那几轮是要花钱的。这句话不是免责套话，是这个模块承认
 * 的失败模式。
 */

/** 压缩档位。`auto` 表示"按定价自己选"。 */
export type CompressionLevel = 'off' | 'light' | 'balanced' | 'aggressive';
export type CompressionChoice = CompressionLevel | 'auto';

/** 每 100 万 token 的单价（与供应商账单同单位，通常是美元）。 */
export interface TokenPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /**
   * 缓存命中的输入单价。`0` 表示"没有缓存优惠"，这时命中部分按 `inputPerMillion` 算 ——
   * 不填不等于免费，这个区别很容易写反，所以下面的 `estimateCost` 明确处理。
   */
  cachedInputPerMillion: number;
}

export const DEFAULT_PRICING: TokenPricing = {
  inputPerMillion: 0,
  outputPerMillion: 0,
  cachedInputPerMillion: 0,
};

/** 与 `Agent.getTokenUsage()` 同形状（字段都可选，因为早期调用方没有这些字段）。 */
export interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
  cache_hit_tokens?: number;
  cache_miss_tokens?: number;
}

export interface CostBreakdown {
  /** 未命中缓存的输入 */
  freshInput: number;
  /** 命中缓存的输入 */
  cachedInput: number;
  /** 输出（推理 token 由供应商算进输出，所以杠杆在"少想"，不在"少说"） */
  output: number;
  total: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const per = (tokens: number, pricePerMillion: number): number => (tokens / 1_000_000) * pricePerMillion;

/** 定价没填时别说"你需要花 $0.00" —— 那是把"不知道"说成"免费"。 */
export function pricingConfigured(pricing: TokenPricing): boolean {
  return num(pricing.inputPerMillion) > 0 || num(pricing.outputPerMillion) > 0;
}

/**
 * 这次用量的花费，拆成三块。
 *
 * `cache_hit_tokens` 和 `cache_miss_tokens` 是供应商报的命中/未命中；只有它们都没有时才把整个
 * `prompt_tokens` 当成未命中。不能默认"有一半命中"—— 猜低了会给用户一个比账单小的数字，而
 * 这个面板的全部意义就是让用户能对照账单。
 */
export function estimateCost(usage: UsageLike, pricing: TokenPricing): CostBreakdown {
  const prompt = num(usage.prompt_tokens);
  const output = num(usage.completion_tokens);
  const hit = num(usage.cache_hit_tokens);
  const miss = num(usage.cache_miss_tokens);

  // 命中 + 未命中与 prompt 不一致时，以 prompt 为准来定"没被命中"的那部分。
  const cachedInput = Math.min(hit, prompt);
  const freshInput = prompt > 0 && (hit > 0 || miss > 0)
    ? Math.max(0, prompt - cachedInput)
    : prompt;

  const inputPrice = num(pricing.inputPerMillion);
  const cachedPrice = num(pricing.cachedInputPerMillion) > 0 ? num(pricing.cachedInputPerMillion) : inputPrice;

  const freshCost = per(freshInput, inputPrice);
  const cachedCost = per(cachedInput, cachedPrice);
  const outputCost = per(output, num(pricing.outputPerMillion));

  return {
    freshInput: freshCost,
    cachedInput: cachedCost,
    output: outputCost,
    total: freshCost + cachedCost + outputCost,
  };
}

/** 一行说明用什么单价算出来的 —— 面板要能自证，否则用户没法判断数字对不对。 */
export function pricingNote(pricing: TokenPricing): string {
  if (!pricingConfigured(pricing)) {
    return '未填写单价：仅显示 token 用量，不估算金额（把「未知」记为「免费」会低估账单）。';
  }
  const parts = [
    `输入 $${num(pricing.inputPerMillion)}/M`,
    `输出 $${num(pricing.outputPerMillion)}/M`,
  ];
  if (num(pricing.cachedInputPerMillion) > 0) parts.push(`缓存命中 $${num(pricing.cachedInputPerMillion)}/M`);
  return `按 ${parts.join(' · ')} 估算。`;
}

/** 可以动的杠杆。除了 `history`，都不删任何东西。 */
export type LeverId = 'reasoning' | 'tool-results' | 'dynamic-injection' | 'history';

export interface Lever {
  id: LeverId;
  title: string;
  /** 这次该不该动它。 */
  applies: boolean;
  /** 动的是钱的那一侧。 */
  side: 'input' | 'output';
  /** 会不会删掉用户的东西。 */
  destructive: boolean;
  /** 为什么选中/不选中 —— 必须引用定价或用量，否则这条建议只是装饰。 */
  why: string;
}

export interface Allocation {
  /** 实际生效的档位（`auto` 已经解出来了）。 */
  level: CompressionLevel;
  /** 用户原本要的。 */
  requested: CompressionChoice;
  /** 钱压在哪一侧。 */
  heavierSide: 'input' | 'output' | 'even';
  /** 已经算出来的花费（定价没填时为全 0）。 */
  cost: CostBreakdown;
  levers: Lever[];
  /** 建议的推理档位（只会往低走，绝不会为了"更聪明"往上抬 —— 那会加钱）。 */
  recommendedThinkingLevel: ThinkingLevel | null;
  /** 是否真的会删减历史。默认 false，且只有用户显式允许 + 档位到 aggressive 才为 true。 */
  historyReduction: boolean;
  /** 必须原样显示给用户。 */
  disclaimer: string;
}

/**
 * 用户要求逐字出现在界面上的那句话。放在这里而不是 UI 里，是为了让它和决策逻辑同一个来源 ——
 * 免得改了策略却忘了改文案，两句话开始互相矛盾。
 */
export const COST_DISCLAIMER =
  '该功能尽量为您减少开支，但不保证不会使您的开支增加：压缩会让模型为了补上被省掉的上下文而多跑几轮，'
  + '那几轮同样要花钱。请对照账单核对，不要只信这里估算。';

export const THINKING_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof THINKING_ORDER[number];

function stepDown(level: ThinkingLevel | null | undefined, steps: number): ThinkingLevel | null {
  const i = THINKING_ORDER.indexOf((level || 'medium') as ThinkingLevel);
  if (i < 0) return null;
  const next = Math.max(0, i - steps);
  return next < i ? THINKING_ORDER[next] : null;
}

/**
 * 按"钱在哪一侧"选档位。
 *
 * 优先用**真实用量**算钱压在哪：这是用户能看到账单的那部分，比价格表更能说明问题。用量还是 0
 * （刚开一条会话）时退回到看价格比 —— 那时能回答"如果按这个价格跑，哪一侧更贵"。
 *
 * 关键的不对称：返回的档位是**输入侧**的压缩强度，所以它只在**输入**占大头时才随占比变狠。
 * 输出占大头时输入侧停在 `light` —— 输入本来就便宜，为了省它去砍上下文是省错地方（而且会
 * 让模型为了补上下文多跑几轮，那些轮次按**输出**计价，反而更贵）。
 *
 * 这个不对称在第一版里写错了：我用了 `max(输出占比, 输入占比)` 来定档位，于是"输出极度占优"
 * 会得出 aggressive —— 也就是最贵的模型配最狠的上下文裁剪。测试里那条"只改单价建议就该不同"
 * 把它照出来了。
 */
function pickLevel(choice: CompressionChoice, cost: CostBreakdown, pricing: TokenPricing): {
  level: CompressionLevel;
  side: 'input' | 'output' | 'even';
  basis: string;
} {
  if (choice !== 'auto') return { level: choice, side: sideOf(cost), basis: '用户指定档位' };

  const total = cost.total;
  if (total > 0) {
    const inputCost = cost.freshInput + cost.cachedInput;
    const inputShare = inputCost / total;
    const money = `按实际用量：输入 $${inputCost.toFixed(4)}、输出 $${cost.output.toFixed(4)}、合计 $${total.toFixed(4)}`;
    if (inputShare > 0.5) {
      const level: CompressionLevel = inputShare >= 0.75 ? 'aggressive' : 'balanced';
      return { level, side: 'input', basis: money };
    }
    return {
      level: 'light',
      side: inputShare === 0.5 ? 'even' : 'output',
      basis: `${money}；输出占比更高，输入侧保持「轻度」（压缩输入会推高输出侧轮次，反而更贵）`,
    };
  }

  // 没有用量：用价格比。输入价缺失时把输入当免费，于是"省输出"是唯一有意义的方向。
  const inP = num(pricing.inputPerMillion);
  const outP = num(pricing.outputPerMillion);
  if (inP <= 0 && outP <= 0) return { level: 'off', side: 'even', basis: '未填写单价且无用量数据：本轮不做任何调整' };
  if (inP <= 0) return { level: 'light', side: 'output', basis: '输入单价为 0：只需优化输出侧，压缩输入没有收益' };
  const ratio = outP / inP;
  if (ratio >= 4) return { level: 'light', side: 'output', basis: `输出单价为输入的 ${ratio.toFixed(1)} 倍：优先优化输出侧，不压缩上下文` };
  if (ratio >= 1.5) return { level: 'balanced', side: 'output', basis: `输出单价为输入的 ${ratio.toFixed(1)} 倍：两侧同时轻度收紧` };
  return { level: 'aggressive', side: 'input', basis: `输入单价接近或高于输出（比值 ${ratio.toFixed(2)}）：优先优化输入侧` };
}

function sideOf(cost: CostBreakdown): 'input' | 'output' | 'even' {
  const inputCost = cost.freshInput + cost.cachedInput;
  if (cost.total <= 0) return 'even';
  const outShare = cost.output / cost.total;
  return outShare > 0.5 ? 'output' : outShare < 0.5 ? 'input' : 'even';
}

/**
 * 把 (定价, 用量, 用户选的档位) 解成一组该动的杠杆。
 *
 * `allowHistoryReduction` 是这个模块唯一一个"可以删东西"的入口，默认必须传 `false`。
 */
export function allocateContext(input: {
  requested: CompressionChoice;
  pricing: TokenPricing;
  usage: UsageLike;
  allowHistoryReduction?: boolean;
  currentThinkingLevel?: ThinkingLevel | null;
}): Allocation {
  const pricing = { ...DEFAULT_PRICING, ...input.pricing };
  const cost = estimateCost(input.usage, pricing);
  const { level, side, basis } = pickLevel(input.requested, cost, pricing);
  const allowHistory = input.allowHistoryReduction === true;

  const reasoningTokens = num(input.usage.reasoning_tokens);
  const outputHeavy = side === 'output' || side === 'even';

  /*
   * 三个不删东西的杠杆。
   *
   * 顺序是有意的：先动输出（推理 token 按输出计价，而且"少想"通常不减任务能力），再动输入里
   * 最肥的那块（工具结果），最后才是"这一轮本来要不要注入"。历史不在这里 —— 它单独一个，因为
   * 它和这三条不是一类东西。
   */
  const levers: Lever[] = [
    {
      id: 'reasoning',
      title: '推理档位',
      side: 'output',
      destructive: false,
      applies: level !== 'off' && outputHeavy,
      why: level === 'off'
        ? '压缩档位为「关闭」：本轮不调整任何一项。'
        : outputHeavy
          ? `输出侧成本更高（${basis}），且推理 token 按输出计价${reasoningTokens > 0 ? `（本会话已产生 ${reasoningTokens} 个推理 token）` : ''}，因此下调一档。`
          : '输入侧成本更高，下调推理档位不降低成本，且会增加往返轮次。',
    },
    {
      id: 'tool-results',
      title: '工具结果裁剪',
      side: 'input',
      destructive: false,
      applies: level === 'balanced' || level === 'aggressive',
      why: (level === 'balanced' || level === 'aggressive')
        ? '工具结果（知识库摘录、命令输出）占输入体积的比例最大；裁剪只影响本轮发送内容，不改动任何已保存记录。'
        : '压缩档位低于「均衡」：工具结果按原样发送。',
    },
    {
      id: 'dynamic-injection',
      title: '动态上下文注入',
      side: 'input',
      destructive: false,
      applies: level !== 'off',
      why: level === 'off'
        ? '压缩档位为「关闭」：沿用上一轮的上下文注入范围。'
        : '仅注入本轮需要的文件、符号与知识库命中，不再携带工作区的全部相关内容。',
    },
    {
      id: 'history',
      title: '历史记录压缩（会减少发送的对话内容）',
      side: 'input',
      destructive: true,
      applies: allowHistory && level === 'aggressive',
      why: !allowHistory
        ? '设置页中的「允许压缩历史记录」为关闭状态，因此本轮不执行该项（默认不压缩任何历史记录）。'
        : level === 'aggressive'
          ? '已允许压缩历史记录，且压缩档位达到「激进」：本轮会减少发送的历史内容。'
          : '已允许压缩历史记录，但压缩档位未达到「激进」：本轮仍不执行。',
    },
  ];

  const recommendedThinkingLevel = (level === 'off' || !outputHeavy)
    ? null
    : stepDown(input.currentThinkingLevel ?? 'medium', level === 'aggressive' ? 2 : 1);

  return {
    level,
    requested: input.requested,
    heavierSide: side,
    cost,
    levers,
    recommendedThinkingLevel,
    historyReduction: allowHistory && level === 'aggressive',
    disclaimer: COST_DISCLAIMER,
  };
}

/** `context` 配置块的解析（YAML / 环境变量的值都是 `unknown`）。 */
export interface ContextBudgetConfig {
  compression: CompressionChoice;
  allowHistoryReduction: boolean;
  pricing: TokenPricing;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  /*
   * 默认 `off`，和 `budget.enabled` 默认 false 同一个理由：不改变默认行为是一个能测的断言，
   * 而不是一句承诺。用户想要省钱才打开。
   */
  compression: 'off',
  /* 默认不删。见文件头：这是那条既有决策变成的开关。 */
  allowHistoryReduction: false,
  pricing: { ...DEFAULT_PRICING },
};

const LEVELS: CompressionLevel[] = ['off', 'light', 'balanced', 'aggressive'];

export function parseContextBudget(raw: unknown, base: ContextBudgetConfig = DEFAULT_CONTEXT_BUDGET): ContextBudgetConfig {
  const out: ContextBudgetConfig = { ...base, pricing: { ...base.pricing } };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;

  if (src.compression === 'auto') out.compression = 'auto';
  else if (typeof src.compression === 'string' && (LEVELS as string[]).includes(src.compression)) {
    out.compression = src.compression as CompressionLevel;
  }

  if (typeof src.allowHistoryReduction === 'boolean') out.allowHistoryReduction = src.allowHistoryReduction;
  else if (src.allowHistoryReduction === 'true' || src.allowHistoryReduction === '1') out.allowHistoryReduction = true;
  else if (src.allowHistoryReduction === 'false' || src.allowHistoryReduction === '0') out.allowHistoryReduction = false;

  const pricing = src.pricing;
  if (pricing && typeof pricing === 'object' && !Array.isArray(pricing)) {
    const p = pricing as Record<string, unknown>;
    for (const key of ['inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion'] as const) {
      const v = p[key];
      if (v === undefined || v === null || v === '') continue;
      const n = Number(v);
      // 负数会被误当成"倒贴"，`NaN` 会让下面的比较静默失效 —— 这两种都拒绝，保留原值。
      if (Number.isFinite(n) && n >= 0) out.pricing[key] = n;
    }
  }
  return out;
}
