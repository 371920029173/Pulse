import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface SheConfig {
  llm: {
    provider: 'openai' | 'anthropic';
    model: string;
    baseUrl: string;
    apiKey: string;
    maxTokens: number;
    temperature: number;
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
  };
  server: {
    port: number;
    host: string;
  };
}

const DEFAULTS: SheConfig = {
  llm: {
    provider: 'openai',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    maxTokens: 4096,
    temperature: 0.3,
  },
  workspace: {
    root: '.',
  },
  kb: {
    dbPath: '.she/kb.sqlite',
    maxChildrenBeforeSplit: 12,
    dormancyThresholdDays: 30,
    activationBudget: 100,
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
    maxOutputBytes: 524288,
    denyDestructiveByDefault: true,
  },
  server: {
    port: 4577,
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

function tryLoadYaml(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf-8');
  const result: Record<string, unknown> = {};
  const stack: { obj: Record<string, unknown>; indent: number }[] = [{ obj: result, indent: -1 }];

  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const match = trimmed.match(/^([\w.]+)\s*:\s*(.*)/);
    if (!match) continue;
    const [, key, value] = match;

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].obj;

    if (!value) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ obj: child, indent });
    } else {
      parent[key] = parseYamlValue(value);
    }
  }
  return result;
}

function parseYamlValue(v: string): unknown {
  v = v.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

export function loadConfig(workspaceRoot?: string): SheConfig {
  const root = workspaceRoot || process.cwd();
  const configNames = ['she.config.yaml', 'config.yaml', 'she.config.yml', 'config.yml'];

  let fileConfig: Record<string, unknown> = {};
  for (const name of configNames) {
    const loaded = tryLoadYaml(resolve(root, name));
    if (loaded) {
      fileConfig = loaded;
      break;
    }
  }

  const config = deepMerge(DEFAULTS as unknown as Record<string, unknown>, fileConfig) as unknown as SheConfig;

  const env = process.env;
  if (env.SHE_LLM_PROVIDER) config.llm.provider = env.SHE_LLM_PROVIDER as 'openai' | 'anthropic';
  if (env.OPENAI_API_KEY && config.llm.provider === 'openai') config.llm.apiKey = env.OPENAI_API_KEY;
  if (env.ANTHROPIC_API_KEY && config.llm.provider === 'anthropic') config.llm.apiKey = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_BASE_URL) config.llm.baseUrl = env.OPENAI_BASE_URL;
  if (env.OPENAI_MODEL) config.llm.model = env.OPENAI_MODEL;
  if (env.ANTHROPIC_MODEL && config.llm.provider === 'anthropic') config.llm.model = env.ANTHROPIC_MODEL;
  if (env.SHE_WORKSPACE) config.workspace.root = env.SHE_WORKSPACE;
  if (env.SHE_PORT) config.server.port = parseInt(env.SHE_PORT, 10);
  if (env.SHE_KB_PATH) config.kb.dbPath = env.SHE_KB_PATH;

  config.workspace.root = resolve(root, config.workspace.root);
  config.kb.dbPath = resolve(config.workspace.root, config.kb.dbPath);

  return config;
}
