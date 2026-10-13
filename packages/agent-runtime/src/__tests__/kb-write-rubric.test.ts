/**
 * 写库判据**本身**也要有判据。
 *
 * 用户报过：「把 KB 当工具用很好，但模型不知道什么东西该放进去（已有判据太薄）」。
 * 那时系统提示词里只有一句「发现决定、事实…时主动 kb_upsert 写回」，工具描述只有去重语义 ——
 * 没有任何可判读的方向。这里钉住三件事：
 *   1. 提示词里有「写什么 / 不写什么 / 怎么写」三条，并点到密钥与「标题＝检索键」；
 *   2. kb_upsert 的工具描述带着同一套判据 —— 模型是在读它的那一刻做决定的；
 *   3. 「不写什么」真的点了瞬时状态这类东西（用户抱怨的另一半：写进去的太水）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KBStore, GroupKBEngine } from '@she/kb';
import type { SheConfig } from '@she/shared';
import { createKBTools } from '../kb-tools.js';
import { getSystemPrompt } from '../system-prompt.js';

const kbConfig: SheConfig['kb'] = {
  dbPath: '',
  maxChildrenBeforeSplit: 12,
  dormancyThresholdDays: 30,
  activationBudget: 100,
  boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
};

describe('写库判据（什么该进库）', () => {
  let dir: string;
  let store: KBStore;
  let engine: GroupKBEngine;
  let tools: ReturnType<typeof createKBTools>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'she-kb-rubric-'));
    store = new KBStore(join(dir, 'kb.sqlite'));
    engine = new GroupKBEngine(store, kbConfig);
    tools = createKBTools(engine);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('提示词：写什么 / 不写什么 / 怎么写 三条都在，且点到密钥与检索键', () => {
    const p = getSystemPrompt(dir, 'general', false);
    assert.match(p, /\*\*写什么\*\*/, '没有「写什么」');
    assert.match(p, /\*\*不写什么\*\*/, '没有「不写什么」');
    assert.match(p, /\*\*怎么写\*\*/, '没有「怎么写」');
    assert.match(p, /密钥/, '没点密钥 —— 这是红线，必须写明「绝不」');
    assert.match(p, /检索键/, '没写「标题就是检索键」，模型就会把标题写成「note」');
    assert.match(p, /瞬时状态|PID/, '没点名瞬时状态这类不该写的东西');
    assert.match(p, /发现的那一刻/, '没写时机：拖到收尾就等于丢掉');
  });

  it('kb_upsert 的工具描述带着同一套判据（决定发生在这里）', () => {
    const def = tools.definitions.find((d) => d.name === 'kb_upsert');
    assert.ok(def, '没有 kb_upsert 这个工具');
    const d = String(def.description);
    assert.match(d, /cannot re-derive/, '工具描述里没有「什么是该写的」判据');
    assert.match(d, /secrets/, '工具描述里没有密钥红线');
    assert.match(d, /retrieval key/, '工具描述里没有「标题＝检索键」');
    assert.match(d, /transient state/, '工具描述里没有「瞬时状态不写」');
  });

  it('不再是当年那句空话（那句话没有方向，等于没写）', () => {
    const p = getSystemPrompt(dir, 'general', false);
    assert.doesNotMatch(p, /发现决定、事实、接口约定、踩坑、环境信息时，主动/);
  });
});
