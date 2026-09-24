import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
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
    /** When true: skip confirm tickets + allow destructive shell. */
    allowAllCommands: boolean;
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
  };
  skills: {
    /** Active skill profile — see SKILL_PROFILES for the full set. */
    profile: SkillProfile;
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
      // Empty = no allowlist. See `SandboxShell.isCommandAllowed` for why it is opt-in.
      allowedCommands: [],
    },
  skills: {
    profile: 'general',
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
  'llm', 'workspace', 'kb', 'sandbox', 'skills', 'automationMode', 'schedule', 'server',
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

export function loadConfig(workspaceRoot?: string): SheConfig {
  const root = workspaceRoot || process.cwd();

  // Load the canonical .env before anything else so both the server and the
  // CLI read the same file that the settings UI writes to.
  loadEnvFile(resolveEnvFile(root));

  const configPath = resolveConfigFile(root);
  const fileConfig = configPath ? (tryLoadYaml(configPath) ?? {}) : {};

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

  // Automation means the agent keeps working. Forcing a confirm on every
  // command makes that mode stop after the first shell call, which is manual
  // mode under another name. An explicit SHE_ALLOW_ALL_COMMANDS still wins.
  if (env.SHE_ALLOW_ALL_COMMANDS === undefined) {
    if (config.automationMode) {
      config.sandbox.allowAllCommands = true;
      config.sandbox.denyDestructiveByDefault = false;
    } else {
      config.sandbox.allowAllCommands = false;
      config.sandbox.denyDestructiveByDefault = true;
    }
  }
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

