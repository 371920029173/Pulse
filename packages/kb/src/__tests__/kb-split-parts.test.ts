/**
 * Split parts (`<group>/part-N`) are storage buckets, not topics.
 *  - they resolve to their logical parent (writes are redirected there by the tools);
 *  - an overflowing part spills into a sibling part instead of nesting `part-3/part-1`;
 *  - group paths are not doubled (names are already full paths).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SheConfig } from '@she/shared';
import { KBStore } from '../store.js';
import {
  GroupKBEngine,
  isSplitPartOf,
  resolveLogicalGroup,
  nextSplitPartIndex,
  collapseGroupNameChain,
} from '../engine.js';

const kbConfig: SheConfig['kb'] = {
  dbPath: '',
  maxChildrenBeforeSplit: 12,
  dormancyThresholdDays: 30,
  activationBudget: 100,
  boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
};

const LOGICAL = 'project/she-live-test';

describe('KB split parts', () => {
  let dir: string;
  let store: KBStore;
  let engine: GroupKBEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'she-kb-split-'));
    store = new KBStore(join(dir, 'kb.sqlite'));
    engine = new GroupKBEngine(store, kbConfig);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const byName = (name: string) => store.getAllGroups().find((g) => g.name === name);
  const fill = (groupId: string, n: number, tag: string) => {
    for (let i = 0; i < n; i++) engine.addMemoryMaintained(groupId, 'fact', `${tag} ${i}`, `${tag} content ${i}`);
  };
  /** A logical group that has already split once into part-1..3. */
  const splitLogical = () => {
    const logical = engine.createGroup(LOGICAL);
    fill(logical.id, 13, 'seed');
    return store.getGroup(logical.id)!;
  };

  it('isSplitPartOf / resolveLogicalGroup walk up through (nested) parts only', () => {
    const logical = splitLogical();
    assert.equal(logical.childGroupIds.length, 3);
    const part3 = byName(`${LOGICAL}/part-3`)!;
    assert.ok(isSplitPartOf(part3, logical));
    assert.equal(engine.resolveLogicalGroup(part3.id)!.id, logical.id);
    assert.ok(engine.isSplitPart(part3.id));
    assert.ok(!engine.isSplitPart(logical.id));

    // Legacy nested state from before the fix still resolves to the logical group.
    const nested = engine.createGroup(`${LOGICAL}/part-3/part-1`, part3.id);
    assert.equal(resolveLogicalGroup(nested, (id) => store.getGroup(id))!.id, logical.id);

    // A real topic group whose name merely looks similar is not a part.
    const topic = engine.createGroup(`${LOGICAL}/partners`, logical.id);
    assert.equal(engine.resolveLogicalGroup(topic.id)!.id, topic.id);
    const other = engine.createGroup('elsewhere');
    const fake = engine.createGroup(`${LOGICAL}/part-9`, other.id);
    assert.equal(engine.resolveLogicalGroup(fake.id)!.id, fake.id);
  });

  it('an overflowing split part spills into a new sibling part instead of nesting', () => {
    const logical = splitLogical();
    const part3 = byName(`${LOGICAL}/part-3`)!;
    fill(part3.id, 12 - part3.memoryIds.length + 1, 'overflow');

    assert.ok(!store.getAllGroups().some((g) => /\/part-\d+\/part-/.test(g.name)), 'no nested part groups');
    const p3 = store.getGroup(part3.id)!;
    assert.equal(p3.memoryIds.length, 12);
    assert.deepEqual(p3.childGroupIds, []);

    const part4 = byName(`${LOGICAL}/part-4`)!;
    assert.ok(part4, 'sibling part-4 created');
    assert.equal(part4.parentGroupId, logical.id);
    assert.equal(part4.memoryIds.length, 1);
    const moved = store.getMemory(part4.memoryIds[0])!;
    assert.deepEqual(moved.groupIds, [part4.id]);
    assert.match(moved.title, /^overflow /, 'the newest memory is the one moved');
    assert.ok(store.getGroup(logical.id)!.childGroupIds.includes(part4.id));

    // Next overflow of part-3 fills part-4 (it has room) rather than creating part-5.
    fill(part3.id, 1, 'again');
    assert.equal(store.getGroup(part4.id)!.memoryIds.length, 2);
    assert.equal(byName(`${LOGICAL}/part-5`), undefined);

    // Every memory is still reachable exactly once.
    const all = store.getAllGroups().flatMap((g) => g.memoryIds);
    assert.equal(all.length, 13 + 12 - 4 + 1 + 1);
    assert.equal(new Set(all).size, all.length);
  });

  it('a legacy nested part spills to the logical parent, not deeper', () => {
    const logical = splitLogical();
    const part3 = byName(`${LOGICAL}/part-3`)!;
    const nested = engine.createGroup(`${LOGICAL}/part-3/part-1`, part3.id);
    fill(nested.id, 13, 'legacy');
    assert.equal(store.getGroup(nested.id)!.childGroupIds.length, 0);
    const part4 = byName(`${LOGICAL}/part-4`)!;
    assert.equal(part4.parentGroupId, logical.id);
    assert.equal(part4.memoryIds.length, 1);
  });

  it('writes to a split container hold direct members, then split into fresh collision-free parts', () => {
    const logical = splitLogical();
    fill(logical.id, 5, 'direct');
    assert.equal(store.getGroup(logical.id)!.memoryIds.length, 5);
    fill(logical.id, 8, 'direct-more');
    const g = store.getGroup(logical.id)!;
    assert.deepEqual(g.memoryIds, []);
    assert.equal(g.childGroupIds.length, 6);
    const names = store.getAllGroups().map((x) => x.name);
    assert.equal(new Set(names).size, names.length, 'no duplicate group names');
    for (const n of [4, 5, 6]) assert.ok(byName(`${LOGICAL}/part-${n}`), `part-${n}`);
  });

  it('normal split numbering skips part numbers that already exist', () => {
    const g = engine.createGroup('topic');
    engine.createGroup('topic/part-5', g.id);
    assert.equal(nextSplitPartIndex('topic', store.getAllGroups()), 6);
    fill(g.id, 13, 'n');
    const names = store.getAllGroups().map((x) => x.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(byName('topic/part-6') && byName('topic/part-7') && byName('topic/part-8'));
  });

  it('group paths are not doubled', () => {
    assert.deepEqual(
      collapseGroupNameChain(['project', LOGICAL, `${LOGICAL}/part-3`, `${LOGICAL}/part-3/part-1`]),
      [`${LOGICAL}/part-3/part-1`],
    );
    assert.deepEqual(collapseGroupNameChain(['programming', 'typescript']), ['programming', 'typescript']);

    const project = engine.createGroup('project');
    const logical = engine.createGroup(LOGICAL, project.id);
    const part3 = engine.createGroup(`${LOGICAL}/part-3`, logical.id);
    const mem = engine.addMemory(part3.id, 'fact', 'zanzibar walrus', 'zanzibar walrus lives here');
    const res = engine.query('zanzibar walrus');
    const trace = res.traces.find((t) => t.nodeId === mem.id)!;
    assert.ok(trace, 'memory found');
    assert.deepEqual(trace.groupPath, [`${LOGICAL}/part-3`]);
    assert.ok(!trace.groupPath.join('').includes(`${LOGICAL}/project`));

    // The full path works as a group-name anchor.
    const byPath = engine.query(`${LOGICAL}/part-3`);
    assert.ok(byPath.nodes.some((n) => n.id === mem.id));
  });
});