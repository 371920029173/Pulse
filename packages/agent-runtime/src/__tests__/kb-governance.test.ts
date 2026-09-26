/**
 * `kb_upsert` / `kb_edit` / `kb_retire`：知识库治理（审计 #7）。
 *
 * 实测原文：「KB 无编辑/退役机制；同题 upsert 不覆盖（更正=追加新节点，旧错误结论仍可检索命中）」。
 * 对照：errorbook 有 forget，KB 没有对应物。这里用真引擎断言三件事：
 *   1. 同题不同内容的 upsert 不会悄悄写（既不静默覆盖，也不静默追加），结果说清楚发生了什么；
 *   2. 能按 id 原地改，旧版本留在历史里；
 *   3. 能退役：默认查不到、includeRetired 可见、可恢复。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KBStore, GroupKBEngine } from '@she/kb';
import type { SheConfig } from '@she/shared';
import { createKBTools } from '../kb-tools.js';

const kbConfig: SheConfig['kb'] = {
  dbPath: '',
  maxChildrenBeforeSplit: 12,
  dormancyThresholdDays: 30,
  activationBudget: 100,
  boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
};

function nodeId(out: string): string {
  const m = out.match(/\[Node: ([^,\]]+)/);
  assert.ok(m, `结果里没有节点 id: ${out}`);
  return m[1];
}

describe('KB 治理工具', () => {
  let dir: string;
  let store: KBStore;
  let engine: GroupKBEngine;
  let tools: ReturnType<typeof createKBTools>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'she-kb-tools-gov-'));
    store = new KBStore(join(dir, 'kb.sqlite'));
    engine = new GroupKBEngine(store, kbConfig);
    tools = createKBTools(engine);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const upsert = (content: string, extra: Record<string, unknown> = {}) =>
    tools.execute('kb_upsert', { groupName: 'qa/round2', title: 'walrus-encoding', content, ...extra });

  it('首次写入照旧 Added', async () => {
    const out = await upsert('runs are garbled');
    assert.match(out, /^Added memory "walrus-encoding"/);
    assert.equal(store.getStats().totalMemories, 1);
  });

  it('同题同内容：不写第二份，并说明是「内容相同」', async () => {
    const first = nodeId(await upsert('runs are garbled'));
    const out = await upsert('runs are garbled');
    assert.match(out, /未写入（内容相同）/);
    assert.equal(nodeId(out), first);
    assert.equal(store.getStats().totalMemories, 1);
  });

  it('同题不同内容：默认拒写，原节点不动，并给出现有内容和可选做法', async () => {
    const first = nodeId(await upsert('runs are garbled'));
    const out = await upsert('runs are UTF-8; the garbling was a reader mistake');
    assert.match(out, /未写入（已有同题节点）/);
    assert.ok(out.includes(first), '要指出是哪个节点挡住了');
    assert.match(out, /runs are garbled/, '要给出现有内容，调用方才能判断');
    assert.match(out, /onExisting="update"/);
    assert.match(out, /kb_retire/);
    assert.equal(store.getStats().totalMemories, 1, '拒写就是一个字节都不写');
    assert.equal(store.getMemory(first)!.content, 'runs are garbled', '不能静默覆盖');
  });

  it('onExisting="update"：原地更新，说明改了什么、旧版本保留', async () => {
    const first = nodeId(await upsert('runs are garbled'));
    const out = await upsert('runs are UTF-8', { onExisting: 'update' });
    assert.match(out, /^Updated memory/);
    assert.match(out, /旧版本（第 1 版）已保留/);
    assert.equal(nodeId(out), first, '更新的是同一个节点，边和引用都不失效');
    const mem = store.getMemory(first)!;
    assert.equal(mem.content, 'runs are UTF-8');
    assert.equal(engine.getHistory(mem)[0].content, 'runs are garbled');
    assert.equal(store.getStats().totalMemories, 1);
  });

  it('onExisting="add"：明确要两条并存才并存，并在结果里点名旧节点', async () => {
    const first = nodeId(await upsert('A'));
    const out = await upsert('B', { onExisting: 'add' });
    assert.match(out, /^Added memory/);
    assert.ok(out.includes(first), '要告诉调用方同组已有同题节点');
    assert.equal(store.getStats().totalMemories, 2);
  });

  it('kb_edit 按 id 改正文 / 标题，旧版本进历史；没变化就不写', async () => {
    const id = nodeId(await upsert('old text'));
    const out = await tools.execute('kb_edit', { nodeId: id, content: 'new text', title: 'walrus-encoding-v2', reason: '复核' });
    assert.match(out, /^Updated memory "walrus-encoding-v2"/);
    assert.match(out, /标题「walrus-encoding」→「walrus-encoding-v2」/);
    assert.match(out, /正文/);
    const mem = store.getMemory(id)!;
    assert.equal(mem.content, 'new text');
    assert.equal(engine.getHistory(mem)[0].reason, '复核');

    const same = await tools.execute('kb_edit', { nodeId: id, content: 'new text' });
    assert.match(same, /没有变化/);
    assert.equal(engine.getHistory(store.getMemory(id)!).length, 1);
  });

  it('kb_edit 的参数错误说清楚', async () => {
    const id = nodeId(await upsert('x'));
    assert.match(await tools.execute('kb_edit', { nodeId: id }), /至少给/);
    assert.match(await tools.execute('kb_edit', { nodeId: id, content: '  ' }), /kb_retire/);
    assert.match(await tools.execute('kb_edit', { nodeId: id, kind: 'bogus' }), /kind 只能是/);
    assert.match(await tools.execute('kb_edit', { nodeId: 'nope', content: 'y' }), /^Error: Memory not found/);
  });

  it('kb_retire：默认检索排除，includeRetired 可见并标出原因，restore 恢复', async () => {
    const wrong = nodeId(await tools.execute('kb_upsert', { groupName: 'env', title: 'zebra-port', content: 'zebra listens on 4577' }));
    const right = nodeId(await tools.execute('kb_upsert', { groupName: 'env', title: 'zebra-port-fixed', content: 'zebra listens on 5577' }));

    assert.match(await tools.execute('kb_retire', { nodeId: wrong }), /必须写 reason/);

    const out = await tools.execute('kb_retire', { nodeId: wrong, reason: '端口记错', replacedBy: right });
    assert.match(out, /已退役节点「zebra-port」/);
    assert.match(out, /includeRetired=true/);
    assert.match(out, /restore=true/);

    const q = await tools.execute('kb_query', { query: 'zebra listens' });
    assert.ok(!q.includes(wrong), `退役节点还在默认结果里: ${q}`);
    assert.ok(q.includes(right));

    const qAll = await tools.execute('kb_query', { query: 'zebra listens', includeRetired: true });
    assert.ok(qAll.includes(wrong));
    assert.match(qAll, /\[已退役\]/);
    assert.match(qAll, new RegExp(`退役原因：端口记错；替代节点：${right}`));

    assert.match(await tools.execute('kb_retire', { nodeId: wrong, reason: 'again' }), /已经是退役状态/);

    const restored = await tools.execute('kb_retire', { nodeId: wrong, restore: true });
    assert.match(restored, /已恢复/);
    assert.ok((await tools.execute('kb_query', { query: 'zebra listens' })).includes(wrong));
    assert.match(await tools.execute('kb_retire', { nodeId: wrong, restore: true }), /本来就是有效状态/);
  });

  it('退役的同题节点不挡新的 upsert —— 退役就是让位', async () => {
    const old = nodeId(await upsert('wrong'));
    await tools.execute('kb_retire', { nodeId: old, reason: 'wrong' });
    const out = await upsert('right');
    assert.match(out, /^Added memory/);
    assert.notEqual(nodeId(out), old);
  });

  it('编辑过的节点在检索结果里带版本号', async () => {
    const id = nodeId(await upsert('quokka alpha'));
    await tools.execute('kb_edit', { nodeId: id, content: 'quokka beta' });
    const q = await tools.execute('kb_query', { query: 'quokka' });
    assert.match(q, /walrus-encoding \(fact\) score=[\d.]+ v2/);
  });

  it('只读子任务：kb_edit / kb_retire 同样被拒，一个字节都不写', async () => {
    const id = nodeId(await upsert('keep me'));
    const ro = createKBTools(engine, { readOnly: true });
    assert.match(await ro.execute('kb_edit', { nodeId: id, content: 'changed' }), /只读/);
    assert.match(await ro.execute('kb_retire', { nodeId: id, reason: 'x' }), /只读/);
    const mem = store.getMemory(id)!;
    assert.equal(mem.content, 'keep me');
    assert.equal(engine.isRetired(mem), false);
    const names = ro.definitions.map((d) => d.name);
    assert.ok(names.includes('kb_edit') && names.includes('kb_retire'), '工具要列着并拒绝，而不是消失');
  });

  it('工具描述说清楚不会静默覆盖', () => {
    const def = tools.definitions.find((d) => d.name === 'kb_upsert')!;
    assert.match(def.description, /Never overwrites silently/);
    assert.ok('onExisting' in (def.parameters.properties as object));
    const q = tools.definitions.find((d) => d.name === 'kb_query')!;
    assert.ok('includeRetired' in (q.parameters.properties as object));
  });
});
