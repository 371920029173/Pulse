/**
 * Model resolution.
 *
 * The fallback order is the contract, and getting it wrong is quiet: an agent that
 * silently uses the wrong endpoint produces answers, just from somewhere the user did
 * not intend to pay. So each rung of the ladder is asserted, along with the case that
 * matters most in practice — a mistyped registry id must not be passed off as a model
 * name.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModel, resolveSubagentModel, modelRegistry, expandEnvRefs, describeModel,
} from '../models.js';
import type { SheConfig, NamedModel } from '../config.js';

/** A config with the top-level settings plus whatever registry is passed. */
function cfg(models?: NamedModel[], extra?: Partial<SheConfig['llm']>): SheConfig {
  return {
    llm: {
      provider: 'openai',
      model: 'top-model',
      baseUrl: 'https://top.example/v1',
      apiKey: 'top-key',
      maxTokens: 4096,
      temperature: 0.3,
      thinkingLevel: 'medium',
      models,
      ...extra,
    },
  } as SheConfig;
}

describe('expandEnvRefs', () => {
  it('替换 ${VAR}', () => {
    assert.equal(expandEnvRefs('sk-${MY_KEY}', { MY_KEY: 'abc' } as never), 'sk-abc');
  });

  it('变量不存在时原样保留（便于发现配置错误）', () => {
    assert.equal(expandEnvRefs('sk-${MISSING}', {} as never), 'sk-${MISSING}');
  });

  it('多个引用都能替换', () => {
    assert.equal(expandEnvRefs('${A}-${B}', { A: '1', B: '2' } as never), '1-2');
  });

  it('没有引用时原样返回', () => {
    assert.equal(expandEnvRefs('plain', {} as never), 'plain');
  });
});

describe('modelRegistry', () => {
  it('没有注册表时返回空', () => {
    assert.deepEqual(modelRegistry(cfg()), []);
  });

  it('补全缺省字段（供应商 / 地址 / 密钥继承顶层）', () => {
    const reg = modelRegistry(cfg([{ id: 'fast', model: 'cheap-model' }]));
    assert.equal(reg.length, 1);
    // Only the model name was given; everything else comes from the top level.
    assert.equal(reg[0].provider, 'openai');
    assert.equal(reg[0].baseUrl, 'https://top.example/v1');
    assert.equal(reg[0].apiKey, 'top-key');
    assert.equal(reg[0].model, 'cheap-model');
  });

  it('显式字段覆盖顶层', () => {
    const reg = modelRegistry(cfg([{
      id: 'other', model: 'm', provider: 'anthropic', baseUrl: 'https://a.example', apiKey: 'k',
    }]));
    assert.equal(reg[0].provider, 'anthropic');
    assert.equal(reg[0].baseUrl, 'https://a.example');
  });

  it('密钥里的环境变量引用会被展开', () => {
    const reg = modelRegistry(
      cfg([{ id: 'x', model: 'm', apiKey: '${SECRET}' }]),
      { SECRET: 'real-key' } as never,
    );
    assert.equal(reg[0].apiKey, 'real-key');
  });

  it('label 缺省为 id', () => {
    const reg = modelRegistry(cfg([
      { id: 'a', model: 'm' },
      { id: 'b', model: 'm', label: 'B 方案' },
    ]));
    assert.equal(reg[0].label, 'a');
    assert.equal(reg[1].label, 'B 方案');
  });

  it('跳过残缺的条目而不是整体失败', () => {
    // A hand-written config file will have mistakes; one bad entry should not take
    // the rest of the registry with it.
    const reg = modelRegistry(cfg([
      { id: 'good', model: 'm' },
      { id: '', model: 'm' },
      { id: 'no-model' } as never,
    ]));
    assert.equal(reg.length, 1);
    assert.equal(reg[0].id, 'good');
  });
});

describe('resolveModel', () => {
  it('没有注册表时用顶层设置', () => {
    const r = resolveModel(cfg());
    assert.equal(r.model, 'top-model');
    assert.equal(r.source, 'top-level');
  });

  it('按 id 命中注册表', () => {
    const r = resolveModel(cfg([
      { id: 'fast', model: 'cheap' },
      { id: 'smart', model: 'expensive' },
    ]), 'smart');
    assert.equal(r.model, 'expensive');
    assert.equal(r.source, 'registry');
    assert.equal(r.id, 'smart');
  });

  it('activeModel 决定默认用哪个', () => {
    const r = resolveModel(cfg([{ id: 'fast', model: 'cheap' }], { activeModel: 'fast' }));
    assert.equal(r.model, 'cheap');
    assert.equal(r.source, 'registry');
  });

  it('显式传入的 want 优先于 activeModel', () => {
    const r = resolveModel(
      cfg([{ id: 'fast', model: 'cheap' }, { id: 'smart', model: 'pricey' }], { activeModel: 'fast' }),
      'smart',
    );
    assert.equal(r.model, 'pricey');
  });

  it('没有注册表时接受字面模型名（不必先注册）', () => {
    const r = resolveModel(cfg(), 'gpt-4o');
    assert.equal(r.model, 'gpt-4o');
    assert.equal(r.source, 'literal');
  });

  it('有注册表但叫别的名字时标记为 literal（由调用方决定是否是笔误）', () => {
    const r = resolveModel(cfg([{ id: 'fast', model: 'cheap' }]), 'fastt');
    assert.equal(r.source, 'literal', '打错字不能被当成命中');
    assert.equal(r.model, 'fastt');
  });

  it('activeModel 指向不存在的 id 时不会静默失败', () => {
    const r = resolveModel(cfg([{ id: 'fast', model: 'cheap' }], { activeModel: 'nope' }));
    assert.equal(r.source, 'literal');
  });
});

describe('resolveSubagentModel', () => {
  it('没配置时跟随主模型（保持旧行为）', () => {
    const r = resolveSubagentModel(cfg());
    assert.equal(r.model.model, 'top-model');
    assert.equal(r.warning, undefined);
  });

  it('配置了就用指定的那个（省钱的用法）', () => {
    const r = resolveSubagentModel(cfg(
      [{ id: 'fast', model: 'cheap' }, { id: 'smart', model: 'expensive' }],
      { activeModel: 'smart', subagentModel: 'fast' },
    ));
    assert.equal(r.model.model, 'cheap');
    assert.equal(r.model.source, 'registry');
    assert.equal(r.warning, undefined);
  });

  it('【关键】打错 id 时回退到主模型并给出警告，而不是拿去当模型名', () => {
    /*
     * Without this, `subagentModel: fastt` becomes a literal model name sent to the
     * main endpoint — which fails at the provider with a message that says nothing
     * about the typo.
     */
    const r = resolveSubagentModel(cfg(
      [{ id: 'fast', model: 'cheap' }, { id: 'smart', model: 'expensive' }],
      { activeModel: 'smart', subagentModel: 'fastt' },
    ));
    assert.equal(r.model.model, 'expensive', '应当回退到主模型');
    assert.equal(r.model.source, 'fallback-to-main');
    assert.ok(r.warning, '必须给出警告');
    assert.match(r.warning!, /fastt/);
    assert.match(r.warning!, /fast/, '警告里应当列出可用的 id');
  });

  it('没有注册表时字面模型名可用（单端点场景）', () => {
    const r = resolveSubagentModel(cfg(undefined, { subagentModel: 'cheap-model' }));
    assert.equal(r.model.model, 'cheap-model');
    assert.equal(r.warning, undefined);
  });
});

describe('describeModel', () => {
  it('来自注册表时同时显示 id 与真实模型名', () => {
    const r = resolveModel(cfg([{ id: 'fast', model: 'cheap-v2' }]), 'fast');
    assert.match(describeModel(r), /fast/);
    assert.match(describeModel(r), /cheap-v2/);
    assert.match(describeModel(r), /registry/);
  });

  it('来自顶层时只显示模型名', () => {
    assert.match(describeModel(resolveModel(cfg())), /top-model/);
  });
});
