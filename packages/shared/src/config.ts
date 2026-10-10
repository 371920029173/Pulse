import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseContextWindowValue } from './context-window.js';
import { loadEnvFile, resolveEnvFile } from './env.js';

/**
 * Canonical thinking-level values, matching the endpoint's `reasoning_effort`
 * enum exactly. Declared once so config parsing, the settings API, and the UI
 * cannot drift apart — the previous hand-written unions were duplicated across
 * four files and had already gone inconsistent (`minimal` and `low` sent the
 * same value to the API).
 */
export const THINKING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * Skill profile values, declared once for the whole monorepo.
 *
 * This union existed in four places (UI dropdown, UI buttons, agent-runtime, and
 * config) and they had already drifted: the Settings dropdown was missing
 * `general` while everything else supported it, so opening Settings on that
 * profile displayed a different one as selected.
 */
export const SKILL_PROFILES = ['dev', 'liberal', 'general', 'custom'] as const;
export type SkillProfile = (typeof SKILL_PROFILES)[number];

/** Minutes since midnight for 'HH:MM', or null when malformed. */
function minutesOfDayLocal(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Parse `SHE_SCHEDULE_WINDOW`.
 *
 * Returns null for an empty or malformed value, which the scheduler reads as "no
 * restriction". Malformed input is reported rather than silently blocking work:
 * a config typo that stops every scheduled run is far worse than one that runs
 * when it was not wanted, because the first is invisible.
 */
export function parseWorkingWindow(raw: string): { start: string; end: string; days?: number[] } | null {
  const text = raw.trim();
  if (!text) return null;

  const [maybeDays, range] = text.includes('@') ? text.split('@', 2) : [null, text];
  const parts = range.split('-');
  if (parts.length !== 2) return null;
  const start = parts[0].trim();
  const end = parts[1].trim();
  if (minutesOfDayLocal(start) === null || minutesOfDayLocal(end) === null) return null;

  let days: number[] | undefined;
  if (maybeDays !== null) {
    days = maybeDays
      .split(',')
      .map((d) => Number(d.trim()))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length === 0) days = undefined;
  }

  return days ? { start, end, days } : { start, end };
}

/**
 * One entry in the model registry.
 *
 * `apiKey` may contain `${VAR}` references, resolved from the environment, so a
 * config file can be committed without carrying secrets.
 */
export interface NamedModel {
  /** How other settings refer to this entry (`activeModel`, `subagentModel`). */
  id: string;
  /** Defaults to the top-level provider when omitted. */
  provider?: 'openai' | 'anthropic';
  model: string;
  /** Defaults to the top-level baseUrl when omitted. */
  baseUrl?: string;
  /** Defaults to the top-level apiKey when omitted. */
  apiKey?: string;
  /** Shown in the UI; falls back to `id`. */
  label?: string;
}

export interface SheConfig {
  llm: {
    provider: 'openai' | 'anthropic';
    model: string;
    baseUrl: string;
    apiKey: string;
    maxTokens: number;
    temperature: number;
    /** Reasoning / depth hint for providers that support it. */
    thinkingLevel: ThinkingLevel;
    /**
     * 一次请求的提示词上限（token）。**0 = 按模型名自动识别。**
     *
     * 这个数字决定"什么时候压"，而它是个会被猜错的值：猜大了是"该压的时候不压"（那时靠模型端
     * 拒绝兜底），猜小了是过早压缩。所以它必须能从设置里改、改完能落盘 —— 否则用户遇到的就是
     * "我知道要填 32k，但填完重启就没了"。
     */
    contextWindow: number;
    /** Optional secondary endpoint when primary fails. */
    fallback?: {
      provider?: 'openai' | 'anthropic';
      model?: string;
      baseUrl?: string;
      apiKey?: string;
    };
    /**
     * Named endpoints.
     *
     * Answers "which vendor?" without editing keys, and — more usefully — lets
     * different jobs use different models. A subagent doing `grep` and `read` does
     * not need the same model as the main reasoning loop, and paying for one is the
     * easiest money to waste.
     *
     * Declared in `she.config.yaml`:
     *
     *   llm:
     *     models:
     *       - id: fast
     *         provider: openai
     *         model: deepseek-flash
     *         baseUrl: https://api.deepseek.com
     *         apiKey: ${SHE_FAST_KEY}
     *
     * Empty means "just use the top-level settings", which is the previous
     * behaviour and stays the default.
     */
    models?: NamedModel[];
    /** Id of the entry in `models` to use for the main conversation. */
    activeModel?: string;
    /**
     * Id (or literal model name) for delegated subtasks.
     *
     * Falls back to whatever the main conversation uses.
     */
    subagentModel?: string;
  };
  workspace: {
    root: string;
  };
  kb: {
    dbPath: string;
    maxChildrenBeforeSplit: number;
    dormancyThresholdDays: number;
    activationBudget: number;
    boostOnAccess: number;
    pulseSeed: {
      initialEnergy: number;
      decayRate: number;
      resonanceThreshold: number;
      maxHops: number;
    };
  };
  sandbox: {
    shell: 'auto' | 'cmd' | 'powershell' | 'bash';
    timeout: number;
    maxOutputBytes: number;
    denyDestructiveByDefault: boolean;
    /** When true: skip confirm tickets + allow destructive shell, and step real isolation aside. */
    allowAllCommands: boolean;
    /**
     * 工作区边界策略 —— 「允许工作区外命令」那一组控件背后的东西。
     *
     * ─────────────────────────────────────────────────────────────────────────
     * 为什么是一个对象而不是继续用一个布尔
     *
     * `allowAllCommands` 把两件不同的事焊在一起：**要不要逐条审批**，和**边界管多宽**。第二轮
     * 实测（`_she-live-test_2` 的 V12–V17）量到的结果就是这两个方向都错：
     *
     *   开 allowAllCommands → 字面越界路径仍然 DENIED（该放的没放）
     *   关 allowAllCommands → `type %TEMP%\x` 这类间接越界一路放行（该问的没问）
     *
     * 根因是越界判定只读命令文本里的**字面路径**，而环境变量、数据文件、`cd /d`、内联程序都能
     * 绕过那一层。`classifyCommand` 把这件事讲清楚：一条命令只能被判成
     * "已证明只读 / 已证明在工作区内 / 无法判定"，第三类必须按危险那侧处理。
     *
     * 于是策略拆成两问，和用户看到的两个控件一一对应：
     *
     *   allow=false                     —— 「允许工作区外命令」没勾：除阅读类外一律要人同意。
     *   allow=true, policy='all'        —— 勾了 + 「所有」：什么都不问。**这一档还会让真隔离让开**
     *                                      （见 `isolation`）：它的原话是"仅限你完全信任的本地环境"，
     *                                      也就是"就在这台电脑上跑"。
     *   allow=true, policy='readonly'   —— 勾了 + 「只读」（默认）：工作区内免问，工作区外的写要问。
     *   allow=true, policy='deny'       —— 勾了 + 「拒绝」：工作区内免问，工作区外一律直接拒绝。
     *
     * 「无法判定」在那三档里一律按**工作区外**处理（阅读类除外）。这不是保守过头：判不出来的原因
     * 就是路径被藏起来了，而藏起来这件事本身没有无害的解释。
     * ─────────────────────────────────────────────────────────────────────────
     */
    outsideWorkspace: {
      /** 勾选了「允许工作区外命令」才为 true。false 时连工作区内的非只读命令也要批准。 */
      allow: boolean;
      /** 只在 `allow` 为 true 时有意义。 */
      policy: 'all' | 'readonly' | 'deny';
    };
    /**
     * Command allowlist. Empty means "not enforced".
     *
     * The denylist (`DESTRUCTIVE_PATTERNS`) can only block harmful forms someone
     * thought of; an allowlist refuses everything not named, which is fail-closed. It is
     * opt-in because switching it on breaks any workflow whose commands are not listed.
     *
     * Every command in a line is checked, not just the first — otherwise
     * `ls && rm -rf /` would pass.
     */
    allowedCommands: string[];
    /**
     * Real isolation for shell commands — layer 4.2 of the isolation-hardening plan.
     *
     * `auto` (default): use the boundary when it is available, otherwise run on the host. The
     * absence of an `isolation` field on the result is then the signal that it did not apply.
     *
     * `wsl`: require the boundary. If WSL (or the node inside it) is unavailable the command is
     * REFUSED rather than run unconfined, because an explicit request that silently degrades is
     * worse than no request — the transcript would say "isolated" about a command that was not.
     *
     * `off`: never. Commands run on the host, under the path jail.
     *
     * Overridden by the max grant: 勾选「允许工作区外命令」+ 档位「所有」（= `allowAllCommands`）把这一档
     * 合成 `off`（`isMaxGrant()` / `effectiveIsolationMode()`），包括显式的 `wsl` —— 那一档的原话是
     * "仅限你完全信任的本地环境"，也就是"就在这台电脑上跑"，此时把它关进命名空间与用户的明确选择
     * 相反。让开是三处一起的（spawn / 描述 / 界面与日志的提示），且提示会点名是哪个档位造成的、
     * 怎么收回去。
     *
     * Why `auto` and not `off`. Layer 4.2 was built, verified with a real boundary and left off by
     * default, and the result was a capability that did not exist as far as any user was concerned:
     * 第七轮评测 measured the default posture as "机制可用且验证过，默认关着" and named it the single
     * biggest gap to S. A boundary nobody gets is a boundary nobody has.
     *
     * `auto` is the defensible default precisely because of what it does when it CANNOT deliver: it
     * degrades to the host and says so (`isolationNotice`), rather than refusing to run. So the
     * change is not "impose the boundary" but "use the boundary where one exists". `wsl` stays
     * opt-in for callers who would rather fail than run unconfined.
     *
     * The cost is real and unchanged: inside the boundary the command is a LINUX process, so
     * `powershell`, `cmd`, `taskkill` and Windows drive paths stop working, and the only Windows
     * path visible is the workspace itself. On a machine with WSL this changes what an existing
     * command does — which is why every isolated result carries an `isolation` field and why the
     * startup notice says which machine you are on. Setting `SHE_SANDBOX_ISOLATION=off` restores the
     * old meaning for a workflow that needs Windows tools.
     */
    isolation: 'off' | 'auto' | 'wsl';
    /** WSL distro to run in. Empty uses WSL's own default. */
    wslDistro: string;
  };
  /**
   * 联网查资料（`web_search` / `web_fetch`）。
   *
   * ─────────────────────────────────────────────────────────────────────────
   * 为什么有一个自带的搜索源，而不是只留 MCP 一条路
   *
   * 能力缺口是实测出来的：工具表里没有任何联网工具，机器上装的 MCP 里也没有搜索服务器（唯一的
   * `fetch` 只暴露 `imageFetch`），所以「让 Agent 自己去查一下」这件事**没有一条路能走**。MCP 是
   * 一条路，但它要求用户先自己找到、装好一个搜索服务器 —— 那不是"能不能查"，那是"你得先知道去哪
   * 装"。所以这里自带免 key 的源，零配置就能用；要更稳的结果就换带 key 的（Tavily）或自建实例
   * （SearXNG）。
   *
   * 默认是 `auto` 而不是钉死某一个免 key 的源，也是实测逼出来的：写下这段的机器上
   * `duckduckgo.com` 连不上（超时，而 `example.com` 通）、`www.bing.com` 通。一个写死的默认源在
   * 另一台机器上就可能永远是坏的，而"工具存在但每次都失败"比"功能不存在"更难自查。`auto` 用先
   * 答上来的那个，并在结果里点名是谁答的。
   *
   * 代价说清楚：查一次就是把关键词发给那个第三方。所以源必须在**工具描述和每条结果里都点名**
   * （`web-tools.ts` 从这份配置渲染，不是写死一句"本工具可联网"），用户看到的是实际在用的源。
   * 不想要任何出境请求就设 `SHE_WEB_PROVIDER=off`，两个工具会拒绝并说明该改哪里。
   *
   * 免 key 的源是**网页解析**，不是官方 API：对方改一次版式就会失效。这条失效必须是响亮的
   * （"响应认不出来"），不能落成"没搜到"—— 后者会被当成"网上没有这件事"。
   * ─────────────────────────────────────────────────────────────────────────
   */
  web: {
    /**
     * `off` 关掉两个工具；`auto`（默认）依次试免 key 的源（DuckDuckGo → Bing），用先答上来的那个；
     * 也可以钉死某一个。带 key（`tavily`）与自建实例（`searxng`）**只能显式选** —— 自动模式不会
     * 替用户花钱，也不会猜一个没配的地址。
     */
    provider: 'off' | 'auto' | 'duckduckgo' | 'bing' | 'tavily' | 'searxng';
    /** Tavily 的 key。免 key 的源不用。 */
    apiKey: string;
    /** `searxng` 必填（自建实例地址）；其余源留空即用官方地址，填了则覆盖（自建代理）。 */
    baseUrl: string;
    /** 一次搜索最多回几条，1–20。 */
    maxResults: number;
    /** 单次请求的超时（毫秒）。超时是一条可重试的失败，不是"没搜到"。 */
    timeoutMs: number;
    /**
     * 单个页面最多取回多少字节（截断，不是报错）。
     *
     * 上限存在是为了不让一条 `web_fetch` 把上下文买走：一个 5MB 的页面按 3.47 字符/token 折算也
     * 远超任何一轮的预算。截断了就在结果里明说截断，而不是假装那就是全文。
     */
    maxFetchBytes: number;
  };
  skills: {
    /** Active skill profile — see SKILL_PROFILES for the full set. */
    profile: SkillProfile;
  };
  /**
   * Cost ceilings for a single turn — **off unless enabled**.
   *
   * The standing decision in this project is that no product quota may cut a real task short
   * (`docs/s-tier-backlog.md`): a task stopped halfway costs more to redo than the overrun it was
   * meant to prevent. That is an argument about the DEFAULT, not about the capability, so this
   * exists as a switch whose default leaves the old behaviour byte-identical —
   * `agent-runtime/src/budget.ts` returns null on every check while `enabled` is false.
   *
   * Not surfaced in the Settings UI on purpose: a ceiling is set by whoever pays the bill, once,
   * in a config file or an environment variable, and a slider that silently caps a long refactor
   * would be the exact complaint the decision above is about.
   *
   * `0` on any axis means "no limit on this axis".
   */
  budget: {
    enabled: boolean;
    /** Model round trips in one turn. */
    maxToolRounds: number;
    /** Tool calls in one turn. */
    maxToolCalls: number;
    /** Prompt + completion tokens for the turn, as the provider reports them. */
    maxTokens: number;
    /** Wall clock for the turn, in seconds. */
    maxSeconds: number;
  };
  /**
   * 动态上下文与成本：用户填的 token 单价决定这一轮往哪一侧省钱。
   *
   * 和 `budget` 的分工：`budget` 是**硬上限**（超过就停），这里是**怎么省**（都不停）。两者都默认
   * 不动任何东西 —— "默认行为不变"是一条能测的断言。
   *
   * `compression: 'off'` + `allowHistoryReduction: false` 是刻意的默认值，因为
   * `agent-runtime/src/__tests__/compaction.test.ts` 钉着一条既有决策：长记录完整发出，什么都不删。
   * 丢历史那条路（早期版本用 8k 摘要替掉 >120k 的对话）实测会让会话可用长度卡死，而且模型为了
   * 补上下文会多跑几轮 —— 更贵。所以它存在，但必须由用户在设置页显式打开。
   */
  context: {
    /** `off` | `light` | `balanced` | `aggressive` | `auto`（auto = 按定价自己选）。 */
    compression: 'off' | 'light' | 'balanced' | 'aggressive' | 'auto';
    /** 是否允许压缩时删减历史记录。默认 false：一条都不删。 */
    allowHistoryReduction: boolean;
    /**
     * 接近窗口上限时自动压缩。默认**开着** —— 见 DEFAULTS 里那一组默认值的说明：
     * 它不删盘上的任何东西，而关掉它的后果是会话一到窗口就死在那儿。
     */
    autoCompact: boolean;
    /** 从窗口的百分之多少开始压（0.1 ~ 1）。默认 0.8。压过一次之后这一格抬到 0.95。 */
    compactAtShare: number;
    /** 压缩激进程度：保守压得早、激进压得晚（没写 compactAtShare 时按它走）。 */
    compactionLevel: 'conservative' | 'balanced' | 'aggressive';
    /** 每 100 万 token 的单价。全 0 表示没填，界面只报 token 数、不报钱。 */
    pricing: {
      inputPerMillion: number;
      outputPerMillion: number;
      /** 缓存命中价。0 表示没有优惠，命中部分按 input 价算（不填不等于免费）。 */
      cachedInputPerMillion: number;
    };
  };
  /** When true: skip confirms, auto KB hygiene, less babysitting (Cursor/CC-like). */
  automationMode: boolean;
  /**
   * Scheduled work.
   *
   * `workingWindow` is when the agent is ALLOWED to start new work — not a limit
   * on work already running. Closing the window must never abort a turn mid-flight
   * (see `schedule.ts` for why), so this is deliberately a start gate, not a
   * kill switch.
   */
  schedule: {
    enabled: boolean;
    /** Seconds between scheduler ticks. */
    tickSeconds: number;
    /** Global window; per-task windows narrow it further. Empty = always allowed. */
    workingWindow: {
      /** 'HH:MM' local time, inclusive. */
      start: string;
      /** 'HH:MM' local time, exclusive. If <= start, the window wraps past midnight. */
      end: string;
      /** Days of week, 0 = Sunday. Empty or absent = every day. */
      days?: number[];
    } | null;
  };
  server: {
    port: number;
    host: string;
  };
}

const DEFAULTS: SheConfig = {
  llm: {
    provider: 'openai',
    model: 'deepseek-flash',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    // 0 means no product cap. A fixed 4096 counted against DeepSeek thinking
    // and cut the chain off before an answer existed.
    maxTokens: 0,
    temperature: 0.3,
    thinkingLevel: 'medium',
    // 0 = 按模型名自动识别（见 context-window.ts）。不猜一个具体数字，是因为猜错的代价比"说出来
    // 这是猜的"更大：状态行与接口都会点名这个数字的来历。
    contextWindow: 0,
    fallback: {
      provider: 'openai',
      model: '',
      baseUrl: '',
      apiKey: '',
    },
  },
  workspace: {
    root: '.',
  },
  kb: {
    /**
     * Empty means "derive it": `<stateDir>/kb.sqlite`.
     *
     * This used to be an absolute path on the author's own machine
     * (`D:/AGI/she-kb/kb.sqlite`), which shipped as the default for every user —
     * on any other machine the drive does not exist and the KB cannot open.
     * The resolved value is filled in below, once the workspace is known.
     */
    dbPath: '',
    maxChildrenBeforeSplit: 12,
    dormancyThresholdDays: 30,
    activationBudget: 1_000_000,
    boostOnAccess: 1.5,
    pulseSeed: {
      initialEnergy: 1.0,
      decayRate: 0.3,
      resonanceThreshold: 0.15,
      maxHops: 6,
    },
  },
    sandbox: {
      shell: 'auto',
      timeout: 30000,
      // 0 means do not truncate command output.
      maxOutputBytes: 0,
      denyDestructiveByDefault: true,
      allowAllCommands: false,
      /*
       * 默认「勾选 + 只读」。
       *
       * 勾选是默认，理由是这个开关回答的是"工作区外能不能碰"，而绝大多数正常工作都在工作区内 ——
       * 默认没勾会让每一条 `ls` 都要点确认，那是把工具变成弹窗机。档位默认「只读」而不是「所有」，
       * 因为「只读」正好等于上一版 `allowAllCommands=false` 时的**意图**：工作区内免问，出去的写要
       * 过问。区别只在于现在这条规则真的被执行（间接越界能被判出来），而不是只看字面路径。
       */
      outsideWorkspace: { allow: true, policy: 'readonly' },
      // Empty = no allowlist. See `SandboxShell.isCommandAllowed` for why it is opt-in.
      allowedCommands: [],
      /*
       * Layer 4.2. `auto` by default — see the type's doc comment for why this is not `off`: a
       * verified boundary that ships disabled is a capability no user has. `auto` still runs on the
       * host wherever WSL is missing or the workspace cannot be mapped, and says so, so the default
       * only arms the boundary on a machine that can actually deliver one.
       */
      isolation: 'auto',
      wslDistro: '',
    },
  /*
   * 默认就有一个能用的搜索源（免 key，`auto` 依次试），否则这条能力对"没先装好 MCP"的人等于不
   * 存在 —— 和隔离档位那次是同一个判断（机制可用但默认关着 = 谁都没有）。代价见类型注释：关键词
   * 会出境到那个源，而这一点在工具描述与每条结果里都点名。要完全关掉：`SHE_WEB_PROVIDER=off`。
   */
  web: {
    provider: 'auto',
    apiKey: '',
    baseUrl: '',
    maxResults: 5,
    timeoutMs: 15_000,
    maxFetchBytes: 512 * 1024,
  },
  skills: {
    profile: 'general',
  },
  /*
   * Off. Every axis is 0 as well, so even a future change that reads a limit without checking
   * `enabled` cannot start enforcing something nobody asked for.
   */
  budget: {
    enabled: false,
    maxToolRounds: 0,
    maxToolCalls: 0,
    maxTokens: 0,
    maxSeconds: 0,
  },
  /*
   * 默认什么都不做：`off` + 不删历史 + 单价全 0。
   *
   * 单价默认 0 而不是"猜一个常见价格"：猜错了面板会给出一个和账单对不上的数字，而用户会以为
   * 那是真的。0 让界面明说"你还没填"，这比一个像模像样的错数好。
   */
  context: {
    compression: 'off',
    allowHistoryReduction: false,
    /*
     * 和上面两个"默认什么都不做"不同，这一对默认**开着**，而且这是刻意的：它们改的是"发给模型的
     * 那一份"，盘上的转写一条不丢（`historyForDisk()` 照旧完整），而关掉它的后果不是"什么都不做"，
     * 是会话一到窗口就死在那儿 —— 用户报的正是这个。
     *
     * 阈值 0.8 而不是贴着 1.0：一次工具调用就可能加进来几千 token，贴着上限触发等于每次都先撞一次墙
     * 再救援。
     */
    autoCompact: true,
    compactAtShare: 0.8,
    compactionLevel: 'balanced',
    pricing: {
      inputPerMillion: 0,
      outputPerMillion: 0,
      cachedInputPerMillion: 0,
    },
  },
  automationMode: true,
  schedule: {
    enabled: true,
    tickSeconds: 30,
    // Null means "no restriction": the agent may start work at any hour. A
    // default window would silently stop overnight runs, which is the opposite of
    // what someone scheduling a nightly job wants.
    workingWindow: null,
  },
  server: {
    port: 5577,
    host: '127.0.0.1',
  },
};

function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(override)) {
    const baseVal = result[key];
    const overVal = override[key];
    if (baseVal && typeof baseVal === 'object' && !Array.isArray(baseVal) && overVal && typeof overVal === 'object' && !Array.isArray(overVal)) {
      result[key] = deepMerge(baseVal as Record<string, unknown>, overVal as Record<string, unknown>);
    } else if (overVal !== undefined) {
      result[key] = overVal;
    }
  }
  return result as T;
}

/**
 * Read the config file.
 *
 * A real YAML parser, not a hand-rolled one.
 *
 * The previous implementation walked lines with `/^([\w.]+)\s*:\s*(.*)/` and did
 * `if (!match) continue` — so anything it did not understand was **silently
 * dropped**. That is wrong for a config file in two ways:
 *
 *   - it could not express a LIST at all, so a multi-model registry (or anything else
 *     list-shaped) would be written by a user, ignored without a word, and the
 *     default used instead;
 *   - a typo in the structure produced no feedback whatsoever, which makes "my setting
 *     has no effect" the hardest kind of bug to chase.
 *
 * A malformed file now THROWS. Failing loudly at startup beats running with a config
 * the user did not intend — they wrote the file, so they want to know it is wrong.
 */
export function tryLoadYaml(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`配置文件无法解析: ${filePath}\n${message}`);
  }
  if (parsed === null || parsed === undefined) return null;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`配置文件的顶层必须是一个映射（key: value），而不是 ${Array.isArray(parsed) ? '列表' : typeof parsed}: ${filePath}`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Keys we read. Anything else is reported rather than ignored — a setting that looks
 * applied but is not is worse than one that fails.
 */
const KNOWN_TOP_LEVEL_KEYS = new Set([
  'llm', 'workspace', 'kb', 'sandbox', 'skills', 'automationMode', 'schedule', 'server', 'budget', 'context',
]);

/** Warn about keys we do not read, so a typo is visible. */
export function unknownTopLevelKeys(config: Record<string, unknown>): string[] {
  return Object.keys(config).filter((k) => !KNOWN_TOP_LEVEL_KEYS.has(k));
}

/**
 * Recognised config filenames, in preference order.
 *
 * `SHE_CONFIG_FILE` overrides the search entirely, matching how `SHE_ENV_FILE` works
 * for `.env`. Without it the file had to sit in the install root — fine for one local
 * install, wrong for a container (read-only image, config on a volume) and for anyone
 * keeping several configurations side by side.
 */
export const CONFIG_FILE_NAMES = ['she.config.yaml', 'config.yaml', 'she.config.yml', 'config.yml'];

/**
 * Locate the config file.
 *
 * Throws when `SHE_CONFIG_FILE` names something that does not exist. Falling back to
 * defaults would look exactly like the settings being ignored, which is the confusion
 * this whole change set is about removing.
 */
function resolveConfigFile(root: string): string | null {
  const explicit = process.env.SHE_CONFIG_FILE;
  if (explicit && explicit.trim()) {
    const p = resolve(explicit.trim());
    if (!existsSync(p)) throw new Error(`SHE_CONFIG_FILE 指向的文件不存在: ${p}`);
    return p;
  }
  for (const name of CONFIG_FILE_NAMES) {
    const p = resolve(root, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * LAST-GOOD CONFIG
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * State files have been quarantined-and-recovered since `state-file.ts`; the config file
 * had nothing. That asymmetry had a sharp edge: a state file that cannot be read costs
 * the user a recoverable copy plus a warning, while a config file that cannot be read
 * stops the whole app from starting — and it does so at the moment the user is least able
 * to see why, because the process that would have printed the reason never came up.
 *
 * The failure is real and common: a hand-edited YAML with a tab where a space belongs, a
 * half-finished edit saved by an editor's autosave, a `git merge` conflict marker. The
 * file is one keystroke away from correct, in a text editor, at any time — so the useful
 * behaviour is not "refuse to start" but "start on what last worked and say exactly what
 * is wrong with what you have now".
 *
 * Two rules keep this from becoming the silent-wrong-config problem it could so easily be:
 *
 *   1. **It never applies quietly.** Every fallback is logged AND surfaced through
 *      `configRecovery()` (exposed on `/api/health` and in the UI), naming the file, the
 *      reason, and when the snapshot was taken. A config that silently is not the one on
 *      disk is worse than one that is not applied at all.
 *   2. **It only covers "cannot be used", not "says something odd".** An unparseable file,
 *      a top-level list, a value of the wrong type — recovered. An unknown key, or a
 *      missing required setting, still throws/warns on its own path, because those are
 *      cases where the file IS readable and the user is mid-thought.
 *
 * The snapshot is a byte copy, not a re-serialisation: re-writing it would discard
 * comments and key order, and the user is expected to open it and copy the good parts
 * back. It is refreshed on every load that succeeds, so it is always the most recent
 * config that actually worked.
 */
export interface ConfigRecovery {
  /** The file that could not be used. */
  file: string;
  /** Why it could not be used, in the user's language. */
  reason: string;
  /** The snapshot that was loaded instead. */
  snapshot: string;
  /** ISO timestamp of the snapshot, when it is known. */
  takenAt?: string;
}

/*
 * The snapshot lives beside the config file it copies — `she.config.yaml.last-good` — rather than
 * in some app directory. Two reasons, both about the moment it matters: the user is in a text
 * editor looking at the broken file, so the good version should be the file next to it; and the
 * path is derived from the config path alone, so `SHE_CONFIG_FILE` pointing at a config on a volume
 * behaves identically without a second root to keep in sync.
 */
/** Where the last config that loaded successfully is kept. */
export function lastGoodConfigPath(configPath: string): string {
  return `${configPath}.last-good`;
}

/** Its sidecar, holding which file the snapshot came from and when. */
export function lastGoodConfigMetaPath(configPath: string): string {
  return `${configPath}.last-good.json`;
}

let configRecovery: ConfigRecovery | null = null;
let configFileInUse: string | null = null;

/**
 * The config file this process read, or null when there was none.
 *
 * Exported because "which file am I actually running" is a question an operator asks, and the
 * answer used to only exist inside `loadConfig`.
 */
export function getConfigFileInUse(): string | null {
  return configFileInUse;
}

/**
 * The last config fallback of this process, or null.
 *
 * Read by the server so the UI can say "you are running the last good config" rather than the user
 * wondering why their edit had no effect. Process-wide and set once at load, which is the only time
 * a config is read.
 */
export function getConfigRecovery(): ConfigRecovery | null {
  return configRecovery;
}

/**
 * 自动化模式与沙箱姿态之间的**张力**，如实报出来 —— 不替用户做选择，也不让它悄悄发生。
 *
 * 背景：以前 `SHE_ALLOW_ALL_COMMANDS` 未显式设置时，`automationMode` 为真会顺手把沙箱放宽成
 * "全部放行 + 不拦破坏性命令"。那个改动是静默的，理由是"严格姿态下自动化会在第一次确认处停下"。
 * 现在两者分开（见 `loadConfig` 里的注释），这个函数负责把那句**真实的**后果说出来：
 *
 *   自动化模式开着，而姿态仍然会拦下需要确认的操作 —— 于是无人值守的一轮会在那里停下来等人。
 *
 * 这是一句提醒，不是一条错误：停下来等人正是「人一直不回应就暂停，不自己做危险的事」要的行为。
 * 需要它自己接着干的人，自己去放宽（`SHE_ALLOW_ALL_COMMANDS` 或设置页）。
 *
 * 纯函数，`config` 是入参：这样它能在不启动服务的情况下被断言，也不会因为读错一个全局状态而给出
 * 与用户实际看到的不同的结论。
 */
export function sandboxPostureNotice(config: SheConfig): string | null {
  if (!config.automationMode) return null;

  const s = config.sandbox;
  const blockers: string[] = [];
  /*
   * 只有**真的会停下来等人**的原因才算。`outsideWorkspace.policy` 是 `readonly` 时，工作区外的读
   * 直接放行、写才要问 —— 所以"边界不是 all"不等于"一定会停"，只有"工作区外的写要问"这一半会在
   * 无人值守时停住。把整个 `readonly` 都算成阻塞会让这条提醒天天出现，然后被无视。
   */
  if (s.denyDestructiveByDefault) blockers.push('破坏性命令');
  if (!s.allowAllCommands && s.outsideWorkspace.policy !== 'all') blockers.push('工作区外的写');
  if (s.allowedCommands.length > 0) blockers.push('白名单外的命令');
  if (blockers.length === 0) return null;

  return `自动化模式已开启，但沙箱仍会为这些操作停下来等你确认：${blockers.join('、')}。`
    + '无人值守的一轮会在那里暂停，直到你回应 —— 这是刻意的（它不会自己批准危险操作）。'
    + '如果确实要让它一路跑完，请自己放宽沙箱档位（`SHE_ALLOW_ALL_COMMANDS` 或设置页），'
    + '而不是让"打开自动化"顺手把边界改掉。';
}

/** Test/embedding seam: forget the recorded fallback. */
export function clearConfigRecovery(): void {
  configRecovery = null;
}

/**
 * Copy the config that just loaded, so the next unreadable edit has something to fall back to.
 *
 * Failures are swallowed on purpose. Not being able to keep a safety net is not a reason to refuse
 * to run with a config that is fine — and the next load simply has no snapshot to offer, which
 * degrades to the old behaviour rather than to something worse.
 *
 * One input is refused: an EMPTY mapping. A file that was emptied (or that holds nothing but
 * comments) still parses cleanly, so it would silently overwrite the good snapshot with "no
 * settings at all" — and the next time the config broke, the fallback would hand back defaults,
 * which is exactly the outcome that must never happen quietly. The snapshot only ever moves
 * forward to a config that actually says something.
 */
function rememberGoodConfig(configPath: string, parsed: Record<string, unknown> | null): void {
  if (!parsed || Object.keys(parsed).length === 0) return;
  try {
    const text = readFileSync(configPath, 'utf8');
    if (text.trim() === '') return;
    const snapshot = lastGoodConfigPath(configPath);
    const tmp = `${snapshot}.${process.pid}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, snapshot);
    const metaTmp = `${lastGoodConfigMetaPath(configPath)}.${process.pid}.tmp`;
    writeFileSync(metaTmp, JSON.stringify({ file: configPath, takenAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
    renameSync(metaTmp, lastGoodConfigMetaPath(configPath));
  } catch {
    /* a missing safety net is not worth failing a boot over */
  }
}

/** What the snapshot knows about itself, tolerating a missing or damaged sidecar. */
function snapshotMeta(configPath: string): { takenAt?: string } {
  try {
    const raw = JSON.parse(readFileSync(lastGoodConfigMetaPath(configPath), 'utf8')) as { takenAt?: unknown };
    return typeof raw.takenAt === 'string' ? { takenAt: raw.takenAt } : {};
  } catch {
    return {};
  }
}

/**
 * Load the config file, falling back to the last good snapshot when it cannot be used.
 *
 * Returns the parsed config plus, when a fallback happened, the record of it. The record is returned
 * rather than only logged so that a check can assert on it without capturing stderr.
 */
function loadConfigFile(root: string): { fileConfig: Record<string, unknown>; configPath: string | null } {
  const configPath = resolveConfigFile(root);
  configFileInUse = configPath;
  if (!configPath) return { fileConfig: {}, configPath: null };

  try {
    const parsed = tryLoadYaml(configPath);
    rememberGoodConfig(configPath, parsed);
    configRecovery = null;
    return { fileConfig: parsed ?? {}, configPath };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const snapshot = lastGoodConfigPath(configPath);
    if (!existsSync(snapshot)) throw err;

    let recovered: Record<string, unknown>;
    try {
      recovered = tryLoadYaml(snapshot) ?? {};
    } catch {
      // The snapshot is unreadable too. Falling back to defaults here would be exactly the "ran
      // with a config nobody chose" outcome the original throw existed to prevent, so the original
      // error is what the user gets.
      throw err;
    }

    configRecovery = {
      file: configPath,
      reason: reason.split('\n')[0] ?? reason,
      snapshot,
      ...snapshotMeta(configPath),
    };
    // eslint-disable-next-line no-console
    console.warn(
      `[config] 「${configPath}」无法使用，改用上一次能用的配置（${snapshot}`
        + `${configRecovery.takenAt ? `，${configRecovery.takenAt}` : ''}）：${configRecovery.reason}\n`
        + '[config] 你改的文件没有被改动，也没有被覆盖。修好后重启即可生效。',
    );
    return { fileConfig: recovered, configPath };
  }
}

export function loadConfig(workspaceRoot?: string): SheConfig {
  const root = workspaceRoot || process.cwd();

  // Load the canonical .env before anything else so both the server and the
  // CLI read the same file that the settings UI writes to.
  loadEnvFile(resolveEnvFile(root));

  const configPath = resolveConfigFile(root);
  const { fileConfig } = loadConfigFile(root);

  /*
   * Report keys we do not read.
   *
   * A setting that looks applied but is not is worse than one that fails: the user
   * edits `llm.modell`, sees no error, and concludes the feature is broken.
   */
  for (const key of unknownTopLevelKeys(fileConfig)) {
    // eslint-disable-next-line no-console
    console.warn(`[config] 未识别的顶层配置键「${key}」—— 它不会有任何效果，请检查拼写。${configPath ? ` (${configPath})` : ''}`);
  }
  const config = deepMerge(DEFAULTS as unknown as Record<string, unknown>, fileConfig) as unknown as SheConfig;

  /*
   * Normalise the budget block against the defaults.
   *
   * A YAML file can say anything: `maxTokens: "20k"` coerces to `NaN`, and `budget:` with no
   * body merges as `null` and would make the block below throw on property access. A value that
   * is not a non-negative number is dropped back to the default rather than coerced, because
   * `NaN >= limit` is FALSE — a bad value would leave the axis permanently unfired while the
   * user believed a ceiling was protecting them, which is the one failure mode this feature
   * cannot afford.
   */
  {
    const fromFile = config.budget as unknown;
    config.budget = { ...DEFAULTS.budget };
    if (fromFile && typeof fromFile === 'object' && !Array.isArray(fromFile)) {
      const src = fromFile as Record<string, unknown>;
      if (typeof src.enabled === 'boolean') config.budget.enabled = src.enabled;
      for (const key of ['maxToolRounds', 'maxToolCalls', 'maxTokens', 'maxSeconds'] as const) {
        const raw = src[key];
        if (raw === undefined || raw === null || raw === '') continue;
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) config.budget[key] = Math.trunc(n);
      }
    }
  }

  /*
   * Normalise the context block.
   *
   * 同一个理由，而且这里的代价更直接：单价如果被 `Number("3.5/M")` 弄成 `NaN`，面板会把花费算成
   * `NaN` 或者 0 —— 用户对照账单发现对不上，然后不信这个功能。所以只接受有限非负数，其余回落到
   * 默认。`compression` 只认那几个字面量：写成 `turbo` 不该悄悄变成 off 之外的东西。
   *
   * 注意默认值：`allowHistoryReduction` 回落到 `false`。文件里写坏了一个键，结果变成"允许删历史"，
   * 是这里最不能出的错。
   */
  {
    const fromFile = config.context as unknown;
    config.context = {
      ...DEFAULTS.context,
      pricing: { ...DEFAULTS.context.pricing },
    };
    if (fromFile && typeof fromFile === 'object' && !Array.isArray(fromFile)) {
      const src = fromFile as Record<string, unknown>;
      if (typeof src.compression === 'string'
        && ['off', 'light', 'balanced', 'aggressive', 'auto'].includes(src.compression)) {
        config.context.compression = src.compression as SheConfig['context']['compression'];
      }
      if (typeof src.allowHistoryReduction === 'boolean') {
        config.context.allowHistoryReduction = src.allowHistoryReduction;
      } else if (src.allowHistoryReduction === 'true' || src.allowHistoryReduction === '1') {
        config.context.allowHistoryReduction = true;
      } else if (src.allowHistoryReduction === 'false' || src.allowHistoryReduction === '0') {
        config.context.allowHistoryReduction = false;
      }
      /*
       * 天花板这一组只认合法的形状，其余回落到默认值：文件里写坏了一个键，不该让"什么时候压"
       * 变成一个没人知道的数。`autoCompact` 的默认方向是"开"，理由见 DEFAULTS。
       */
      if (typeof src.autoCompact === 'boolean') {
        config.context.autoCompact = src.autoCompact;
      } else if (src.autoCompact === 'true' || src.autoCompact === '1') {
        config.context.autoCompact = true;
      } else if (src.autoCompact === 'false' || src.autoCompact === '0') {
        config.context.autoCompact = false;
      }
      if (src.compactionLevel === 'conservative' || src.compactionLevel === 'balanced' || src.compactionLevel === 'aggressive') {
        config.context.compactionLevel = src.compactionLevel;
      }
      const atShare = Number(src.compactAtShare);
      if (Number.isFinite(atShare) && atShare > 0.1 && atShare < 1) config.context.compactAtShare = atShare;
      const pricing = src.pricing;
      if (pricing && typeof pricing === 'object' && !Array.isArray(pricing)) {
        const p = pricing as Record<string, unknown>;
        for (const key of ['inputPerMillion', 'outputPerMillion', 'cachedInputPerMillion'] as const) {
          const raw = p[key];
          if (raw === undefined || raw === null || raw === '') continue;
          const n = Number(raw);
          if (Number.isFinite(n) && n >= 0) config.context.pricing[key] = n;
        }
      }
    }
  }

  /*
   * `llm.contextWindow`：0 是合法值（回到自动识别），所以这里不能写成 `if (raw)` —— 那会把 0 当成
   * "没填"，这一格就永远关不掉自动识别。写坏的值（`"40k"`、负数、null）一律回落到 0，而不是被
   * 当成一个窗口用。
   */
  {
    const raw = (config.llm as { contextWindow?: unknown }).contextWindow;
    config.llm.contextWindow = parseContextWindowValue(raw) ?? 0;
  }

  const env = process.env;
  if (env.SHE_LLM_PROVIDER === 'openai' || env.SHE_LLM_PROVIDER === 'anthropic') {
    config.llm.provider = env.SHE_LLM_PROVIDER;
  }
  /*
   * Model registry selections.
   *
   * `SHE_MODEL` accepts a registry id (see `llm.models` in she.config.yaml) or a
   * literal model name, so switching models does not require re-registering anything
   * and does not require touching API keys.
   */
  if (env.SHE_MODEL) config.llm.activeModel = env.SHE_MODEL.trim();
  if (env.SHE_SUBAGENT_MODEL) config.llm.subagentModel = env.SHE_SUBAGENT_MODEL.trim();
  if (env.OPENAI_API_KEY && config.llm.provider === 'openai') config.llm.apiKey = env.OPENAI_API_KEY;
  // Alias shared with local AGI-use thin stack
  if (!config.llm.apiKey && env.AGI_USE_API_KEY && config.llm.provider === 'openai') config.llm.apiKey = env.AGI_USE_API_KEY;
  if (env.ANTHROPIC_API_KEY && config.llm.provider === 'anthropic') config.llm.apiKey = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_BASE_URL) config.llm.baseUrl = env.OPENAI_BASE_URL;
  if (env.OPENAI_MODEL) config.llm.model = env.OPENAI_MODEL;
  if (env.ANTHROPIC_MODEL && config.llm.provider === 'anthropic') config.llm.model = env.ANTHROPIC_MODEL;
  if (env.SHE_WORKSPACE) config.workspace.root = env.SHE_WORKSPACE;
  if (env.SHE_PORT) config.server.port = parseInt(env.SHE_PORT, 10);
  /*
   * Bind address.
   *
   * `server.host` existed in the config type but had NO environment variable, so it
   * was permanently 127.0.0.1 — the server could not accept a connection from
   * another machine or from outside a container, which makes private/cloud
   * deployment impossible. It is now settable, and the request guard is widened to
   * match (see `guardRequest`).
   */
  if (env.SHE_HOST) config.server.host = env.SHE_HOST.trim();
  if (env.SHE_KB_PATH) config.kb.dbPath = env.SHE_KB_PATH;  if (env.SHE_AUTOMATION_MODE === '0' || env.SHE_AUTOMATION_MODE === 'false') config.automationMode = false;
  if (env.SHE_AUTOMATION_MODE === '1' || env.SHE_AUTOMATION_MODE === 'true') config.automationMode = true;

  /*
   * 自动化模式**不改**沙箱姿态。
   *
   * 这里原先有一段：`SHE_ALLOW_ALL_COMMANDS` 未显式设置时，`automationMode` 为真就把
   * `sandbox.allowAllCommands` 强制成 `true`、`denyDestructiveByDefault` 强制成 `false`。理由是
   * "每条命令都要确认会让自动化模式在第一条 shell 调用之后就停下"。
   *
   * 那个理由是真的，但它管的是**另一个问题**：它说明的是"自动化模式在严格姿态下会停下来等人"，
   * 而不是"自动化模式应该放宽边界"。把前者当成后者的理由，结果就是**打开自动化**（一个关于"它能不
   * 能自己接着干"的开关）顺手改掉了一个关于"它能碰哪里"的开关 —— 而用户没有同意后者，界面上也没
   * 有任何一处说明发生了这件事。实测过：只开自动化模式去改 `.env`，沙箱档位跟着变了。
   *
   * 两个问题分开，各自回答：
   *
   *   - 「能碰哪里」由 `outsideWorkspace` / `allowAllCommands` / `denyDestructiveByDefault` 回答，
   *     默认是 fail-closed（见 DEFAULTS 里 `outsideWorkspace` 的注释）。要放宽就显式设
   *     `SHE_ALLOW_ALL_COMMANDS` 或走设置页 —— 那是**用户**的决定。
   *   - 「自动化模式在严格姿态下会停在确认上」由 `sandboxPostureNotice()` 如实说出来，让人自己选，
   *     而不是替他做了这个选择。这就是本仓库对这类问题的既有做法：收敛 MCP 根要回显、坏配置要报
   *     `degraded`、未隔离要说"未隔离" —— 改动可以发生，但不能不吭声。
   *
   * 显式的 `SHE_ALLOW_ALL_COMMANDS` 仍然照常生效，只是处理它的是下面那两段既有的代码（在
   * `SHE_DENY_DESTRUCTIVE` 与 `outsideWorkspace` 缺省推导之前），这里不再重复一遍 —— 两处读同一个
   * 变量就是两处会不一致。
   */

  if (env.SHE_THINKING_LEVEL && THINKING_LEVELS.includes(env.SHE_THINKING_LEVEL as never)) {
    config.llm.thinkingLevel = env.SHE_THINKING_LEVEL as typeof config.llm.thinkingLevel;
  }

  /*
   * Sampling limits.
   *
   * These are persisted by the Settings route, and this is the other half of that pair: without
   * reading them back, the write was in-memory only and every restart silently restored the
   * default. A user who moved the slider saw it work and then quietly lose the setting —
   * `check:restart` is what caught it.
   *
   * Parsed rather than truth-checked because 0 is meaningful (`maxTokens: 0` means "no product
   * cap", see DEFAULTS), so `parseInt(x) || fallback` would discard a legitimate value.
   */
  const readNonNegative = (raw: string | undefined): number | undefined => {
    if (raw === undefined || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const maxTokens = readNonNegative(env.SHE_LLM_MAX_TOKENS);
  if (maxTokens !== undefined) config.llm.maxTokens = Math.trunc(maxTokens);
  const temperature = readNonNegative(env.SHE_LLM_TEMPERATURE);
  if (temperature !== undefined) config.llm.temperature = temperature;

  /*
   * Scheduled-work window.
   *
   * Accepted forms:
   *   SHE_SCHEDULE_WINDOW=09:00-18:00            every day
   *   SHE_SCHEDULE_WINDOW=1,3,5@09:00-18:00      Mon/Wed/Fri (0 = Sunday)
   *   SHE_SCHEDULE_WINDOW=                       no restriction
   *
   * A malformed value is logged and treated as "no restriction" rather than
   * blocking every run — a typo should not silently stop all scheduled work.
   */
  if (env.SHE_SCHEDULE_ENABLED !== undefined) {
    const off = ['0', 'false', 'no'].includes(env.SHE_SCHEDULE_ENABLED.toLowerCase());
    config.schedule.enabled = !off;
  }
  if (env.SHE_SCHEDULE_WINDOW !== undefined) {
    config.schedule.workingWindow = parseWorkingWindow(env.SHE_SCHEDULE_WINDOW);
  }
  if (env.SHE_SCHEDULE_TICK_SECONDS) {
    const n = parseInt(env.SHE_SCHEDULE_TICK_SECONDS, 10);
    if (Number.isFinite(n) && n >= 5) config.schedule.tickSeconds = n;
  }
  if (!config.llm.fallback) config.llm.fallback = { provider: 'openai', model: '', baseUrl: '', apiKey: '' };
  if (env.SHE_LLM_FALLBACK_BASE_URL) config.llm.fallback.baseUrl = env.SHE_LLM_FALLBACK_BASE_URL;
  if (env.SHE_LLM_FALLBACK_API_KEY) config.llm.fallback.apiKey = env.SHE_LLM_FALLBACK_API_KEY;
  if (env.SHE_LLM_FALLBACK_MODEL) config.llm.fallback.model = env.SHE_LLM_FALLBACK_MODEL;
  if (env.SHE_LLM_FALLBACK_PROVIDER === 'openai' || env.SHE_LLM_FALLBACK_PROVIDER === 'anthropic') {
    config.llm.fallback.provider = env.SHE_LLM_FALLBACK_PROVIDER;
  }
  if (env.SHE_SKILL_PROFILE === 'dev' || env.SHE_SKILL_PROFILE === 'liberal' || env.SHE_SKILL_PROFILE === 'general' || env.SHE_SKILL_PROFILE === 'custom') {
    config.skills.profile = env.SHE_SKILL_PROFILE;
  }
  /*
   * Cost ceilings. All optional, all off by default.
   *
   * `SHE_BUDGET_ENABLED` is what turns enforcement on; setting a limit alone does nothing, which
   * is deliberate — an environment where someone exported `SHE_BUDGET_MAX_TOKENS` for another
   * purpose must not silently start cutting turns short. Malformed values are ignored (leaving
   * that axis unlimited) rather than coerced to 0, because 0 already means "unlimited" and a
   * typo that reads as "unlimited" is only visible if it is reported. It is NOT reported here —
   * `readNonNegative` is used, which drops non-numeric input silently; the check script and
   * `parseBudgetLimits` are where the shape is asserted.
   */
  if (env.SHE_BUDGET_ENABLED !== undefined) {
    const raw = env.SHE_BUDGET_ENABLED.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(raw)) config.budget.enabled = true;
    else if (['0', 'false', 'no', 'off'].includes(raw)) config.budget.enabled = false;
  }
  const budgetRounds = readNonNegative(env.SHE_BUDGET_MAX_TOOL_ROUNDS);
  if (budgetRounds !== undefined) config.budget.maxToolRounds = Math.trunc(budgetRounds);
  const budgetCalls = readNonNegative(env.SHE_BUDGET_MAX_TOOL_CALLS);
  if (budgetCalls !== undefined) config.budget.maxToolCalls = Math.trunc(budgetCalls);
  const budgetTokens = readNonNegative(env.SHE_BUDGET_MAX_TOKENS);
  if (budgetTokens !== undefined) config.budget.maxTokens = Math.trunc(budgetTokens);
  const budgetSeconds = readNonNegative(env.SHE_BUDGET_MAX_SECONDS);
  if (budgetSeconds !== undefined) config.budget.maxSeconds = budgetSeconds;
  /*
   * 动态上下文与定价。全部可选，默认不动。
   *
   * `SHE_ALLOW_HISTORY_REDUCTION` 只认显式的真值：写坏的值**不**打开它。这是这个文件里唯一一个
   * "打开就会删用户东西"的开关，所以它的解析必须 fail-closed —— 一个拼错的环境变量不该导致历史
   * 被压缩。
   */
  if (env.SHE_CONTEXT_COMPRESSION !== undefined) {
    const raw = env.SHE_CONTEXT_COMPRESSION.trim().toLowerCase();
    if (['off', 'light', 'balanced', 'aggressive', 'auto'].includes(raw)) {
      config.context.compression = raw as SheConfig['context']['compression'];
    }
  }
  if (env.SHE_ALLOW_HISTORY_REDUCTION !== undefined) {
    const raw = env.SHE_ALLOW_HISTORY_REDUCTION.trim().toLowerCase();
    config.context.allowHistoryReduction = ['1', 'true', 'yes', 'on'].includes(raw);
  }
  /*
   * 上下文天花板。`SHE_CONTEXT_WINDOW` 认正整数；0 与写坏的值都表示"按模型名自动识别"。
   *
   * 阈值只认 (0.1, 1) 开区间：1.0 等于把压缩关掉，而"关掉"应该由开关说，不该由一个阈值顺手做掉 ——
   * 那样用户会看到开关是开的、压缩却永远不触发。
   */
  const contextWindow = parseContextWindowValue(env.SHE_CONTEXT_WINDOW);
  if (contextWindow !== undefined) config.llm.contextWindow = contextWindow;
  if (env.SHE_CONTEXT_AUTO_COMPACT !== undefined) {
    const raw = env.SHE_CONTEXT_AUTO_COMPACT.trim().toLowerCase();
    config.context.autoCompact = ['1', 'true', 'yes', 'on'].includes(raw);
  }
  const level = String(env.SHE_CONTEXT_COMPACTION_LEVEL ?? '').toLowerCase();
  if (level === 'conservative' || level === 'balanced' || level === 'aggressive') config.context.compactionLevel = level;
  const compactAtShare = Number(env.SHE_CONTEXT_COMPACT_AT);
  if (Number.isFinite(compactAtShare) && compactAtShare > 0.1 && compactAtShare < 1) {
    config.context.compactAtShare = compactAtShare;
  }
  const priceIn = readNonNegative(env.SHE_PRICE_INPUT_PER_MILLION);
  if (priceIn !== undefined) config.context.pricing.inputPerMillion = priceIn;
  const priceOut = readNonNegative(env.SHE_PRICE_OUTPUT_PER_MILLION);
  if (priceOut !== undefined) config.context.pricing.outputPerMillion = priceOut;
  const priceCached = readNonNegative(env.SHE_PRICE_CACHED_INPUT_PER_MILLION);
  if (priceCached !== undefined) config.context.pricing.cachedInputPerMillion = priceCached;
  if (env.SHE_ALLOW_ALL_COMMANDS === '1' || env.SHE_ALLOW_ALL_COMMANDS === 'true') {
    config.sandbox.allowAllCommands = true;
    config.sandbox.denyDestructiveByDefault = false;
  }
  /*
   * Command allowlist, comma-separated. `*` disables enforcement.
   *
   * `SHE_ALLOWED_COMMANDS=node,pnpm,git,grep,ls,cat` is a fail-closed configuration: an
   * agent working in a repo needs a handful of tools, and naming them is a better
   * guarantee than blocking patterns someone thought of.
   */
  if (env.SHE_ALLOWED_COMMANDS !== undefined) {
    const raw = env.SHE_ALLOWED_COMMANDS.trim();
    config.sandbox.allowedCommands = raw === ''
      ? []
      : raw.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  }
  if (env.SHE_ALLOW_ALL_COMMANDS === '0' || env.SHE_ALLOW_ALL_COMMANDS === 'false') {
    config.sandbox.allowAllCommands = false;
    if (!config.sandbox.denyDestructiveByDefault) config.sandbox.denyDestructiveByDefault = true;
  }
  if (env.SHE_DENY_DESTRUCTIVE === '0' || env.SHE_DENY_DESTRUCTIVE === 'false') {
    config.sandbox.denyDestructiveByDefault = false;
  }

  /*
   * 工作区边界。「允许工作区外命令」+ 三档策略。
   *
   * 位置在 `SHE_ALLOW_ALL_COMMANDS` / `SHE_DENY_DESTRUCTIVE` 之后，因为它们要参与缺省推导 —— 缺省
   * 时从已经解析完的 `allowAllCommands` 推，而不是回到硬编码默认值。
   *
   * 这样做的理由是**不改变任何现存安装的行为**：一个已经写着 `SHE_ALLOW_ALL_COMMANDS=true` 的
   * .env（本机就是）升上来仍然是全放行，只是现在这件事在设置页里看得见、也能改。反过来，如果这里
   * 让缺省值覆盖掉那个变量，用户升级后会发现自己勾过的开关被悄悄关掉了 —— 那正是第二轮实测里
   * 「开关两个方向都不可靠」的前半句。
   */
  if (env.SHE_ALLOW_OUTSIDE_WORKSPACE !== undefined) {
    const raw = env.SHE_ALLOW_OUTSIDE_WORKSPACE.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(raw)) config.sandbox.outsideWorkspace.allow = true;
    else if (['0', 'false', 'no', 'off'].includes(raw)) config.sandbox.outsideWorkspace.allow = false;
    // 别的写法一律不认：这个开关关掉时连工作区内的命令都要批准，猜错的代价是每步一个弹窗，
    // 或者反过来完全不管。两种都比"保持原值"糟。
  } else {
    config.sandbox.outsideWorkspace.allow = true;
  }
  if (env.SHE_OUTSIDE_WORKSPACE_POLICY !== undefined) {
    const raw = env.SHE_OUTSIDE_WORKSPACE_POLICY.trim().toLowerCase();
    if (raw === 'all' || raw === 'readonly' || raw === 'deny') {
      config.sandbox.outsideWorkspace.policy = raw;
    }
  } else {
    config.sandbox.outsideWorkspace.policy = config.sandbox.allowAllCommands ? 'all' : 'readonly';
  }
  /*
   * Real isolation (layer 4.2). `SHE_SANDBOX_ISOLATION=wsl` asks for the boundary; an unrecognised
   * value is ignored rather than guessed at, so a typo cannot quietly arm the strict mode that
   * refuses every command when WSL is missing.
   */
  if (env.SHE_SANDBOX_ISOLATION !== undefined) {
    const raw = env.SHE_SANDBOX_ISOLATION.trim().toLowerCase();
    if (raw === 'off' || raw === 'auto' || raw === 'wsl') config.sandbox.isolation = raw;
  }
  if (env.SHE_WSL_DISTRO !== undefined) config.sandbox.wslDistro = env.SHE_WSL_DISTRO.trim();

  /*
   * 联网搜索源。
   *
   * 认不出的值**忽略**（和 `SHE_SANDBOX_ISOLATION` 同一条理由）：拼错一个源名就静默变成"不能联网"
   * 或者悄悄换一个源，两种都比留在默认值上更难查。
   *
   * `SHE_WEB_PROVIDER=off` 是明确的"不要联网"，不是"没配"—— 两个工具会拒绝并说明去哪改回来。
   */
  if (env.SHE_WEB_PROVIDER !== undefined) {
    const raw = env.SHE_WEB_PROVIDER.trim().toLowerCase();
    if (raw === 'off' || raw === 'auto' || raw === 'duckduckgo' || raw === 'bing' || raw === 'tavily' || raw === 'searxng') {
      config.web.provider = raw;
    }
  }
  if (env.SHE_WEB_API_KEY !== undefined) config.web.apiKey = env.SHE_WEB_API_KEY.trim();
  if (env.SHE_WEB_BASE_URL !== undefined) config.web.baseUrl = env.SHE_WEB_BASE_URL.trim();
  if (env.SHE_WEB_MAX_RESULTS !== undefined) {
    const n = Number(env.SHE_WEB_MAX_RESULTS);
    // 夹在 1–20：0 会让工具看起来"搜了但什么都没有"，那是最像"网上没有"的一种假象。
    if (Number.isFinite(n) && n >= 1) config.web.maxResults = Math.min(Math.trunc(n), 20);
  }
  if (env.SHE_WEB_TIMEOUT_MS !== undefined) {
    const n = Number(env.SHE_WEB_TIMEOUT_MS);
    if (Number.isFinite(n) && n >= 1_000) config.web.timeoutMs = Math.min(Math.trunc(n), 120_000);
  }

  config.workspace.root = (/^[a-zA-Z]:[\\/]/.test(config.workspace.root) || config.workspace.root.startsWith('/'))
    ? resolve(config.workspace.root)
    : resolve(root, config.workspace.root);
  // An empty dbPath means "use the default location", never the workspace root
  // itself — resolving '' would yield a directory and the KB would fail to open.
  config.kb.dbPath = config.kb.dbPath.trim()
    ? resolve(config.workspace.root, config.kb.dbPath)
    : resolve(config.workspace.root, '.she', 'kb.sqlite');

  return config;
}

