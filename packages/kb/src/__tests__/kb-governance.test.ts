/**
 * 知识库治理（审计 #7）：节点可以原地编辑（保留旧版本）、可以退役（默认检索排除、可恢复）。
 *
 * 实测原文：「KB 无编辑/退役机制；同题 upsert 不覆盖（更正=追加新节点，旧错误结论仍可检索命中）」。
 * 这里测的是引擎层：编辑不丢历史、退役后查不到、includeRetired 能看到、restore 能回来，
 * 以及老库（没有任何治理标记的节点）照常可用 —— 标记放在 metadata 里，不需要迁移。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { KBStore } from '../store.js';
import { GroupKBEngine, KB_HISTORY_MAX, KB_RETIRED_KEY } from '../engine.js';
import type { SheConfig } from '@she/shared';

const kbConfig: SheConfig['kb'] = {
  dbPath: '',
  maxChildrenBeforeSplit: 12,
  dormancyThresholdDays: 30,
  activationBudget: 100,
  boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
};

describe('KB 治理：编辑 / 退役', () => {
  let dir: string;
  let store: KBStore;
  let engine: GroupKBEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'she-kb-gov-'));
    store = new KBStore(join(dir, 'kb.sqlite'));
    engine = new GroupKBEngine(store, kbConfig);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reviseMemory 原地改：id 不变，旧版本进历史，版本号 +1', () => {
    const g = engine.createGroup('qa/round2');
    const mem = engine.addMemory(g.id, 'fact', '运行记录编码', '运行记录乱码，是产品缺陷');
    const r = engine.reviseMemory(mem.id, { content: '运行记录是标准 UTF-8，乱码是读取方式误报' }, '复核后更正');

    assert.deepEqual(r.changed, ['content']);
    assert.equal(r.version, 2);
    assert.equal(r.after.id, mem.id);
    const again = store.getMemory(mem.id)!;
    assert.equal(again.content, '运行记录是标准 UTF-8，乱码是读取方式误报');
    const history = engine.getHistory(again);
    assert.equal(history.length, 1);
    assert.equal(history[0].content, '运行记录乱码，是产品缺陷', '旧版本必须保留，不能静默覆盖');
    assert.equal(history[0].version, 1);
    assert.equal(history[0].reason, '复核后更正');
    assert.deepEqual(again.groupIds, [g.id], '编辑不能把节点移出原来的组');
  });

  it('没有变化的编辑什么都不写', () => {
    const g = engine.createGroup('g');
    const mem = engine.addMemory(g.id, 'fact', 'T', 'C');
    const r = engine.reviseMemory(mem.id, { content: 'C', title: 'T' });
    assert.deepEqual(r.changed, []);
    assert.equal(engine.getHistory(store.getMemory(mem.id)!).length, 0);
    assert.equal(engine.getVersion(store.getMemory(mem.id)!), 1);
  });

  it(`历史只保留最近 ${KB_HISTORY_MAX} 版`, () => {
    const g = engine.createGroup('g');
    const mem = engine.addMemory(g.id, 'fact', 'T', 'v1');
    for (let i = 2; i <= KB_HISTORY_MAX + 3; i++) engine.reviseMemory(mem.id, { content: `v${i}` });
    const after = store.getMemory(mem.id)!;
    const history = engine.getHistory(after);
    assert.equal(history.length, KB_HISTORY_MAX);
    assert.equal(history[history.length - 1].content, `v${KB_HISTORY_MAX + 2}`);
    assert.equal(engine.getVersion(after), KB_HISTORY_MAX + 3);
  });

  it('退役后默认检索查不到，includeRetired 能查到，restore 后回来', () => {
    const g = engine.createGroup('env');
    const wrong = engine.addMemory(g.id, 'fact', 'zebra-port', 'zebra service listens on port 4577');
    const right = engine.addMemory(g.id, 'fact', 'zebra-port-fix', 'zebra service listens on port 5577');

    assert.ok(engine.query('zebra port').nodes.some((n) => n.id === wrong.id), '前提：退役前能查到');

    const retired = engine.retireMemory(wrong.id, { reason: '端口记错了', replacedBy: right.id });
    assert.equal(engine.isRetired(retired), true);
    assert.equal(engine.getRetirement(retired)!.replacedBy, right.id);

    const ids = engine.query('zebra port').nodes.map((n) => n.id);
    assert.ok(!ids.includes(wrong.id), '退役节点不应再被默认检索命中');
    assert.ok(ids.includes(right.id), '替代节点照常可查');
    assert.ok(!engine.query(`#zebra-port`).nodes.some((n) => n.id === wrong.id), '精确锚点也不应绕过退役');

    const withRetired = engine.query('zebra port', { includeRetired: true }).nodes.map((n) => n.id);
    assert.ok(withRetired.includes(wrong.id), 'includeRetired=true 要能看到退役节点');

    assert.ok(store.getMemory(wrong.id), '退役不是删除');
    engine.restoreMemory(wrong.id);
    assert.equal(engine.isRetired(store.getMemory(wrong.id)!), false);
    assert.ok(engine.query('zebra port').nodes.some((n) => n.id === wrong.id), 'restore 后重新参与检索');
  });

  it('退役要写原因，replacedBy 必须是另一个存在的节点', () => {
    const g = engine.createGroup('g');
    const mem = engine.addMemory(g.id, 'fact', 'T', 'C');
    assert.throws(() => engine.retireMemory(mem.id, { reason: '  ' }), /reason/);
    assert.throws(() => engine.retireMemory(mem.id, { reason: 'x', replacedBy: mem.id }), /itself/);
    assert.throws(() => engine.retireMemory(mem.id, { reason: 'x', replacedBy: 'nope' }), /not found/);
    assert.throws(() => engine.retireMemory('nope', { reason: 'x' }), /not found/);
    assert.equal(engine.isRetired(store.getMemory(mem.id)!), false, '失败的退役不能留下半个标记');
  });

  it('findByTitle 看得到被分裂进子组的节点，且默认跳过退役的', () => {
    const g = engine.createGroup('project/x');
    const child = engine.createGroup('project/x/part-1', g.id);
    const inChild = engine.addMemory(child.id, 'fact', '端口 约定', 'A');
    assert.deepEqual(engine.findByTitle(g.id, '  端口   约定 ').map((m) => m.id), [inChild.id]);
    engine.retireMemory(inChild.id, { reason: 'obsolete' });
    assert.deepEqual(engine.findByTitle(g.id, '端口 约定'), []);
    assert.equal(engine.findByTitle(g.id, '端口 约定', { includeRetired: true }).length, 1);
  });

  it('老库：没有治理标记的节点照常是有效状态，打开旧文件不需要迁移', () => {
    store.close();
    // 按旧版 schema 直接写一行，metadata 是 '{}' —— 升级前写下的节点就是这个形状。
    const path = join(dir, 'kb.sqlite');
    const raw = new Database(path);
    const now = Date.now();
    raw.prepare(`INSERT INTO groups (id, name, memory_ids, created_at, updated_at) VALUES ('g-old', 'legacy', '["m-old"]', ?, ?)`).run(now, now);
    raw.prepare(`INSERT INTO memories (id, kind, title, content, metadata, group_ids, last_accessed_at, created_at, updated_at)
      VALUES ('m-old', 'fact', 'legacy-walrus', 'walrus note from an old library', '{}', '["g-old"]', ?, ?, ?)`).run(now, now, now);
    raw.close();

    store = new KBStore(path);
    engine = new GroupKBEngine(store, kbConfig);
    const old = store.getMemory('m-old')!;
    assert.equal(engine.isRetired(old), false);
    assert.equal(engine.getVersion(old), 1);
    assert.ok(engine.query('walrus').nodes.some((n) => n.id === 'm-old'));
    engine.retireMemory('m-old', { reason: 'test' });
    assert.ok(KB_RETIRED_KEY in store.getMemory('m-old')!.metadata);
  });
});
