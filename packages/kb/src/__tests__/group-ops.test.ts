/**
 * 知识图谱 s1 的判据：组操作 + 批量应用器 + **快照回滚**的完整往返。
 *
 * 回滚那一条是这次最关键的一条：它不走 HTTP，直接证明「先快照、后覆盖、再打开」这件事成立 ——
 * 因为服务端的 /api/kb/rollback 做的就是这套动作（关句柄 → 覆盖 → remount），中间没有别的东西。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KBStore, GroupKBEngine } from '../index.js';

let dir = '';
let store: KBStore;
let engine: GroupKBEngine;

const kbConfig = () => ({
  dbPath: join(dir, 'kb.sqlite'),
  maxChildrenBeforeSplit: 12,
  dormancyThresholdDays: 30,
  activationBudget: 100,
  boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
}) as never;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'she-graph-'));
  store = new KBStore(join(dir, 'kb.sqlite'));
  engine = new GroupKBEngine(store, kbConfig());
});
afterEach(() => {
  try { store.close(); } catch { /* 已关就算了 */ }
  rmSync(dir, { recursive: true, force: true });
});

const group = (name: string, parentId?: string) => engine.createGroup(name, parentId);
/*
 * 走引擎的 addMemory：它同时写 memory.groupIds 与 group.memoryIds（镜像）。
 * 用 store.createMemory 造数据会绕过镜像，于是 getMemoriesByGroup 是空的 —— 实测过。
 */
const mem = (groupId: string, title: string) =>
  engine.addMemory(groupId, 'fact', title, `关于 ${title} 的内容`);

describe('知识图谱：组操作', () => {
  it('改名：能改，空名与超长名被拒', () => {
    const a = group('A');
    assert.equal(engine.renameGroup(a.id, '  新名字  ').name, '新名字');
    assert.throws(() => engine.renameGroup(a.id, '   '), /不能为空/);
    assert.throws(() => engine.renameGroup(a.id, 'x'.repeat(121)), /过长/);
  });

  it('移动：关系两侧都对，能移到根，环会被挡下', () => {
    const a = group('A');
    const b = group('B');
    const c = group('C', a.id);

    engine.moveGroup(c.id, b.id);
    assert.equal(store.getGroup(c.id)!.parentGroupId, b.id);
    assert.ok(store.getGroup(b.id)!.childGroupIds.includes(c.id));
    assert.ok(!store.getGroup(a.id)!.childGroupIds.includes(c.id), '旧父级要摘掉');

    engine.moveGroup(c.id, null);
    assert.equal(store.getGroup(c.id)!.parentGroupId, null);
    assert.ok(!store.getGroup(b.id)!.childGroupIds.includes(c.id));

    engine.moveGroup(c.id, a.id);
    assert.throws(() => engine.moveGroup(a.id, c.id), /cycle/i, '把祖先挂到后代下面必须被拒');
  });

  it('合并：记忆与子组都搬过去，from 消失，记忆变成归属 into', () => {
    const a = group('A');
    const b = group('B');
    const child = group('C', a.id);
    const m1 = mem(a.id, '一');
    const m2 = mem(a.id, '二');
    const m3 = mem(b.id, '三');

    const out = engine.mergeGroups(a.id, b.id);
    assert.deepEqual(out, { movedMemories: 2, movedGroups: 1 });
    assert.equal(store.getGroup(a.id), undefined, 'from 应当消失');
    assert.equal(store.getGroup(child.id)!.parentGroupId, b.id);
    const bNow = store.getGroup(b.id)!;
    for (const id of [m1.id, m2.id, m3.id]) assert.ok(bNow.memoryIds.includes(id), `${id} 应在 B 下`);
    for (const id of [m1.id, m2.id]) {
      const g = store.getMemory(id)!.groupIds;
      assert.ok(g.includes(b.id) && !g.includes(a.id), '记忆应改挂 into、不再挂 from');
    }
  });

  it('批量应用：按顺序执行；一条失败就停在它那里并报出位置', () => {
    const a = group('A');
    const ok = engine.applyOps([
      { kind: 'createGroup', name: 'B', parentId: a.id },
      { kind: 'renameGroup', id: a.id, name: 'A2' },
    ]);
    assert.equal(ok.applied, 2);
    assert.equal(ok.failedAt, null);
    assert.equal(store.getGroup(a.id)!.name, 'A2');

    const bad = engine.applyOps([
      { kind: 'createGroup', name: 'C', parentId: a.id },
      { kind: 'renameGroup', id: '不存在', name: 'x' },
      { kind: 'createGroup', name: 'D', parentId: a.id },
    ]);
    assert.equal(bad.applied, 1, '第一条已生效');
    assert.equal(bad.failedAt, 1);
    assert.match(String(bad.error), /not found/i);
    assert.equal(store.getAllGroups().filter((g) => g.name === 'D').length, 0, '失败之后的不许执行');
  });
});

describe('知识图谱：快照与回滚', () => {
  it('快照 → 改动 → 覆盖回滚：回到快照那一刻', async () => {
    const before = group('回滚前就有的组');
    const snapshot = join(dir, 'snap.sqlite');
    await store.snapshotTo(snapshot);
    assert.ok(existsSync(snapshot));

    // 改动：新建一个组 + 给已有组改名
    group('快照之后才建的组');
    engine.renameGroup(before.id, '改过的名字');
    assert.equal(store.getAllGroups().filter((g) => g.name === '快照之后才建的组').length, 1);

    // 回滚：等价于服务端做的"关 → 覆盖 → 重挂"
    store.close();
    copyFileSync(snapshot, join(dir, 'kb.sqlite'));
    for (const suffix of ['-wal', '-shm']) rmSync(join(dir, 'kb.sqlite') + suffix, { force: true });
    store = new KBStore(join(dir, 'kb.sqlite'));
    engine = new GroupKBEngine(store, kbConfig());

    assert.equal(store.getAllGroups().filter((g) => g.name === '快照之后才建的组').length, 0, '快照后的新建必须消失');
    assert.equal(store.getGroup(before.id)!.name, '回滚前就有的组', '改名也必须被回滚');
  });
});
