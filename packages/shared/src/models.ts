/**
 * Resolving which model an agent should actually use.
 *
 * Its own module because the answer depends on three inputs — the top-level `llm`
 * settings, the named registry, and which role is asking (main loop vs. a delegated
 * subtask). Spread across the constructors, each caller ended up re-implementing the
 * fallback order slightly differently, which is how "why is it using that model?"
 * becomes unanswerable.
 *
 * The order is one-directional and explicit:
 *
 *   registry id  →  literal model name  →  top-level settings
 *
 * A literal name is accepted so that "point at a different model" does not require
 * registering it first. An unknown id when a registry EXISTS is not treated as a
 * literal: that turns a typo into a confusing provider error instead of a clear one.
 */
import type { SheConfig, NamedModel } from './config.js';

/** The effective connection settings for one agent role. */
export interface ResolvedModel {
  provider: 'openai' | 'anthropic';
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Where the answer came from. Surfaced in logs, and asserted in tests. */
  source: 'top-level' | 'registry' | 'literal' | 'fallback-to-main';
  /** The registry id, when the answer came from the registry. */
  id?: string;
}

/** Expand `${VAR}` from the environment. An unresolved reference is left as written. */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{(\w+)\}/g, (whole, name: string) => env[name] ?? whole);
}

/** A registry entry with every field filled in and references expanded. */
export interface ResolvedRegistryEntry {
  id: string;
  label: string;
  provider: 'openai' | 'anthropic';
  model: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * The registry with defaults applied and `${VAR}` references resolved.
 *
 * An entry may omit `provider`, `baseUrl` and `apiKey`, in which case the top-level
 * values are used. That is what makes several ids on one vendor cheap to declare —
 * you write the model name and nothing else.
 */
export function modelRegistry(config: SheConfig, env: NodeJS.ProcessEnv = process.env): ResolvedRegistryEntry[] {
  const top = config.llm;
  const entries: NamedModel[] = config.llm.models ?? [];
  return entries
    /*
     * Skip malformed entries rather than failing the whole registry.
     *
     * A config file edited by hand will contain mistakes, and one bad entry should
     * not remove every model the user defined. `''` has to be rejected explicitly:
     * `typeof '' === 'string'`, so a presence check alone lets an empty id through —
     * an entry that can never be referenced and could be matched by accident.
     */
    .filter((m) =>
      m
      && typeof m.id === 'string' && m.id.trim().length > 0
      && typeof m.model === 'string' && m.model.trim().length > 0)
    .map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      provider: m.provider ?? top.provider,
      model: m.model,
      baseUrl: m.baseUrl ? expandEnvRefs(m.baseUrl, env) : top.baseUrl,
      apiKey: m.apiKey ? expandEnvRefs(m.apiKey, env) : top.apiKey,
    }));
}

/**
 * Resolve the model for a role.
 *
 * @param want A registry id, a literal model name, or undefined to use the active
 *             default (`llm.activeModel`, else the top-level settings).
 */
export function resolveModel(config: SheConfig, want?: string, env: NodeJS.ProcessEnv = process.env): ResolvedModel {
  const top = config.llm;
  const registry = modelRegistry(config, env);
  const target = (want ?? '').trim() || config.llm.activeModel?.trim() || '';

  if (target) {
    const hit = registry.find((m) => m.id === target);
    if (hit) {
      return { provider: hit.provider, model: hit.model, baseUrl: hit.baseUrl, apiKey: hit.apiKey, source: 'registry', id: hit.id };
    }
    /*
     * Not a registry id, so treat it as a literal model name — legitimate when
     * pointing at another model on the same endpoint, and when no registry exists at
     * all. Callers that can tell the difference (a mistyped id) check `source` and
     * decide; see `resolveSubagentModel`.
     */
    return { provider: top.provider, model: target, baseUrl: top.baseUrl, apiKey: top.apiKey, source: 'literal' };
  }

  return { provider: top.provider, model: top.model, baseUrl: top.baseUrl, apiKey: top.apiKey, source: 'top-level' };
}

/** What a role's resolution needs to know, when a mistake should be reported. */
export interface SubagentResolution {
  model: ResolvedModel;
  /** Set when `subagentModel` named something that is not in the registry. */
  warning?: string;
}

/**
 * Resolve the model a delegated subtask should use.
 *
 * Subtasks do mechanical work (grep, read, summarise), so pointing them at a cheaper
 * model is the easiest cost saving available — and it is the practical form of
 * "choose a suitable model for the job" rather than a slogan.
 */
export function resolveSubagentModel(config: SheConfig, env: NodeJS.ProcessEnv = process.env): SubagentResolution {
  const want = config.llm.subagentModel?.trim();
  const registry = modelRegistry(config, env);

  if (!want) {
    return { model: resolveModel(config, undefined, env) };
  }

  const resolved = resolveModel(config, want, env);
  if (resolved.source === 'registry') return { model: resolved };

  /*
   * Either a literal name (fine when there is no registry) or a mistyped id (not
   * fine). Sending the main conversation's model name to a different endpoint would
   * fail somewhere less obvious, so a mistyped id falls back to the main model and
   * says why.
   */
  if (registry.length > 0) {
    return {
      model: { ...resolveModel(config, undefined, env), source: 'fallback-to-main' },
      warning:
        `llm.subagentModel="${want}" 不在模型注册表里（可用: ${registry.map((m) => m.id).join(', ')}），`
        + '已回退到主模型。',
    };
  }
  return { model: resolved };
}

/** Human-readable one-liner, for logs. */
export function describeModel(m: ResolvedModel): string {
  const which = m.id ? `${m.id} → ${m.model}` : m.model;
  return `${m.provider}/${which} (${m.source})`;
}
