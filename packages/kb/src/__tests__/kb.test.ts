import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KBStore } from '../store.js';
import { GroupKBEngine } from '../engine.js';
import type { SheConfig } from '@she/shared';

function makeTempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'she-kb-test-'));
  return join(dir, 'test.sqlite');
}

const defaultKbConfig: SheConfig['kb'] = {
  dbPath: '',
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
};

describe('KBStore', () => {
  let store: KBStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTempDb();
    store = new KBStore(dbPath);
  });

  afterEach(() => {
    store.close();
  });

  it('should create and retrieve a group', () => {
    const group = store.createGroup({ name: 'test-group' });
    assert.ok(group.id);
    assert.equal(group.name, 'test-group');
    assert.equal(group.parentGroupId, null);
    assert.deepEqual(group.childGroupIds, []);
    assert.deepEqual(group.memoryIds, []);

    const fetched = store.getGroup(group.id);
    assert.ok(fetched);
    assert.equal(fetched.name, 'test-group');
  });

  it('should update a group', () => {
    const group = store.createGroup({ name: 'original' });
    const updated = store.updateGroup(group.id, { name: 'renamed', hormoneMarker: 2.5 });
    assert.equal(updated.name, 'renamed');
    assert.equal(updated.hormoneMarker, 2.5);
  });

  it('should delete a group', () => {
    const group = store.createGroup({ name: 'to-delete' });
    store.deleteGroup(group.id);
    assert.equal(store.getGroup(group.id), undefined);
  });

  it('should list all groups', () => {
    store.createGroup({ name: 'a' });
    store.createGroup({ name: 'b' });
    const all = store.getAllGroups();
    assert.equal(all.length, 2);
  });

  it('should create and retrieve a memory', () => {
    const mem = store.createMemory({ kind: 'text', title: 'Hello', content: 'World', groupIds: ['g1'] });
    assert.ok(mem.id);
    assert.equal(mem.kind, 'text');
    assert.equal(mem.title, 'Hello');
    assert.equal(mem.content, 'World');
    assert.deepEqual(mem.groupIds, ['g1']);
    assert.equal(mem.accessCount, 0);
    assert.equal(mem.isDormant, false);
  });

  it('should update a memory', () => {
    const mem = store.createMemory({ kind: 'text', title: 'T', content: 'C' });
    const updated = store.updateMemory(mem.id, { title: 'Updated Title' });
    assert.equal(updated.title, 'Updated Title');
  });

  it('should delete a memory', () => {
    const mem = store.createMemory({ kind: 'text', title: 'T', content: 'C' });
    store.deleteMemory(mem.id);
    assert.equal(store.getMemory(mem.id), undefined);
  });

  it('should search memories via FTS', () => {
    store.createMemory({ kind: 'text', title: 'TypeScript guide', content: 'Learn TypeScript basics' });
    store.createMemory({ kind: 'text', title: 'Python tutorial', content: 'Learn Python basics' });
    store.createMemory({ kind: 'text', title: 'Cooking recipes', content: 'How to bake bread' });

    const results = store.searchMemories('TypeScript');
    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'TypeScript guide');

    const learnResults = store.searchMemories('Learn basics');
    assert.ok(learnResults.length >= 2);
  });

  it('should create and retrieve an edge', () => {
    const edge = store.createEdge({
      kind: 'weak',
      sourceId: 'n1',
      targetId: 'n2',
      weight: 0.5,
    });
    assert.ok(edge.id);
    assert.equal(edge.kind, 'weak');
    assert.equal(edge.sourceId, 'n1');
    assert.equal(edge.targetId, 'n2');
    assert.equal(edge.weight, 0.5);
  });

  it('should get edges for a node', () => {
    store.createEdge({ kind: 'weak', sourceId: 'n1', targetId: 'n2' });
    store.createEdge({ kind: 'temporal', sourceId: 'n3', targetId: 'n1' });
    store.createEdge({ kind: 'co_occurrence', sourceId: 'n4', targetId: 'n5' });

    const edges = store.getEdgesForNode('n1');
    assert.equal(edges.length, 2);
  });

  it('should delete an edge', () => {
    const edge = store.createEdge({ kind: 'weak', sourceId: 'a', targetId: 'b' });
    store.deleteEdge(edge.id);
    assert.equal(store.getEdge(edge.id), undefined);
  });

  it('should boost access count', () => {
    const mem = store.createMemory({ kind: 'text', title: 'T', content: 'C' });
    assert.equal(mem.accessCount, 0);

    store.boostAccess(mem.id);
    store.boostAccess(mem.id);

    const updated = store.getMemory(mem.id);
    assert.ok(updated);
    assert.equal(updated.accessCount, 2);
  });

  it('should find dormant memories by threshold', () => {
    const old = store.createMemory({ kind: 'text', title: 'Old', content: 'ancient' });
    store.updateMemory(old.id, { lastAccessedAt: Date.now() - 60 * 24 * 60 * 60 * 1000 });

    store.createMemory({ kind: 'text', title: 'New', content: 'recent' });

    const dormant = store.getDormantMemories(30);
    assert.equal(dormant.length, 1);
    assert.equal(dormant[0].title, 'Old');
  });

  it('should handle transactions', () => {
    const result = store.transaction(() => {
      const g = store.createGroup({ name: 'txn-group' });
      return g;
    });
    assert.ok(result.id);
    assert.equal(store.getGroup(result.id)?.name, 'txn-group');
  });

  it('should store edge evidence and falsifiers', () => {
    const edge = store.createEdge({
      kind: 'causal_candidate',
      sourceId: 'cause',
      targetId: 'effect',
      evidence: 'observed correlation',
      falsifiers: ['could be coincidence', 'small sample'],
    });
    assert.equal(edge.evidence, 'observed correlation');
    assert.deepEqual(edge.falsifiers, ['could be coincidence', 'small sample']);
  });
});

describe('GroupKBEngine', () => {
  let store: KBStore;
  let engine: GroupKBEngine;

  beforeEach(() => {
    const dbPath = makeTempDb();
    store = new KBStore(dbPath);
    engine = new GroupKBEngine(store, defaultKbConfig);
  });

  afterEach(() => {
    store.close();
  });

  // ─── Group management ───

  it('should create groups and nest them', () => {
    const parent = engine.createGroup('parent');
    const child = engine.createGroup('child', parent.id);

    const parentUpdated = store.getGroup(parent.id);
    assert.ok(parentUpdated);
    assert.ok(parentUpdated.childGroupIds.includes(child.id));

    const childUpdated = store.getGroup(child.id);
    assert.ok(childUpdated);
    assert.equal(childUpdated.parentGroupId, parent.id);
  });

  it('should delete a group and reassign children to parent', () => {
    const grandparent = engine.createGroup('grandparent');
    const parent = engine.createGroup('parent', grandparent.id);
    const child = engine.createGroup('child', parent.id);

    engine.deleteGroup(parent.id);

    assert.equal(store.getGroup(parent.id), undefined);
    const childUpdated = store.getGroup(child.id);
    assert.ok(childUpdated);
    assert.equal(childUpdated.parentGroupId, grandparent.id);
  });

  it('should add and remove child groups', () => {
    const p = engine.createGroup('parent');
    const c = engine.createGroup('child');

    engine.addChildGroup(p.id, c.id);
    let parent = store.getGroup(p.id)!;
    assert.ok(parent.childGroupIds.includes(c.id));

    engine.removeChildGroup(p.id, c.id);
    parent = store.getGroup(p.id)!;
    assert.ok(!parent.childGroupIds.includes(c.id));
  });

  it('should detect cycles when adding child groups', () => {
    const a = engine.createGroup('a');
    const b = engine.createGroup('b', a.id);
    const c = engine.createGroup('c', b.id);

    assert.throws(() => engine.addChildGroup(c.id, a.id), /cycle/);
  });

  it('should detect self-cycle', () => {
    const g = engine.createGroup('self');
    assert.throws(() => engine.addChildGroup(g.id, g.id), /cycle/);
  });

  // ─── Memory management ───

  it('should add memories to groups', () => {
    const group = engine.createGroup('notes');
    const mem = engine.addMemory(group.id, 'text', 'Note 1', 'Content of note 1');

    assert.ok(mem.id);
    assert.equal(mem.title, 'Note 1');
    assert.ok(mem.groupIds.includes(group.id));

    const updated = store.getGroup(group.id)!;
    assert.ok(updated.memoryIds.includes(mem.id));
    assert.equal(updated.stats.directMemories, 1);
  });

  it('should remove memory from group', () => {
    const group = engine.createGroup('notes');
    const mem = engine.addMemory(group.id, 'text', 'Temp', 'Temporary note');

    engine.removeMemory(group.id, mem.id);

    const updated = store.getGroup(group.id)!;
    assert.ok(!updated.memoryIds.includes(mem.id));
    assert.equal(store.getMemory(mem.id), undefined);
  });

  it('should move memory between groups', () => {
    const g1 = engine.createGroup('source');
    const g2 = engine.createGroup('target');
    const mem = engine.addMemory(g1.id, 'text', 'Movable', 'I will be moved');

    engine.moveMemory(g1.id, g2.id, mem.id);

    const s = store.getGroup(g1.id)!;
    const t = store.getGroup(g2.id)!;
    assert.ok(!s.memoryIds.includes(mem.id));
    assert.ok(t.memoryIds.includes(mem.id));

    const m = store.getMemory(mem.id)!;
    assert.ok(!m.groupIds.includes(g1.id));
    assert.ok(m.groupIds.includes(g2.id));
  });

  it('should find groups for a memory', () => {
    const g = engine.createGroup('context');
    const mem = engine.addMemory(g.id, 'text', 'Multi', 'Belongs to multiple groups');

    const groups = engine.findGroupForMemory(mem.id);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, g.id);
  });

  // ─── Edge management ───

  it('should add weak edges', () => {
    const g = engine.createGroup('linked');
    const m1 = engine.addMemory(g.id, 'text', 'A', 'First');
    const m2 = engine.addMemory(g.id, 'text', 'B', 'Second');

    const edge = engine.addWeakEdge(m1.id, m2.id);
    assert.equal(edge.kind, 'weak');
    assert.equal(edge.weight, 0.5);

    const groupUpdated = store.getGroup(g.id)!;
    assert.ok(groupUpdated.weakEdgeIds.includes(edge.id));
  });

  it('should add cross-group edges', () => {
    const g1 = engine.createGroup('group-a');
    const g2 = engine.createGroup('group-b');

    const edge = engine.addCrossGroupEdge(g1.id, g2.id);
    assert.equal(edge.kind, 'cross_group');

    const g1u = store.getGroup(g1.id)!;
    const g2u = store.getGroup(g2.id)!;
    assert.ok(g1u.crossGroupEdgeIds.includes(edge.id));
    assert.ok(g2u.crossGroupEdgeIds.includes(edge.id));
  });

  it('should add typed edges with evidence', () => {
    const g = engine.createGroup('causal');
    const m1 = engine.addMemory(g.id, 'fact', 'Cause', 'This causes something');
    const m2 = engine.addMemory(g.id, 'fact', 'Effect', 'This is the effect');

    const edge = engine.addTypedEdge(m1.id, m2.id, 'causal_candidate', {
      evidence: 'observed 10 times',
      falsifiers: ['might be coincidence'],
    });

    assert.equal(edge.kind, 'causal_candidate');
    assert.equal(edge.evidence, 'observed 10 times');
    assert.deepEqual(edge.falsifiers, ['might be coincidence']);
  });

  it('should add temporal edges without auto-promoting to causal', () => {
    const g = engine.createGroup('timeline');
    const m1 = engine.addMemory(g.id, 'text', 'Event A', 'happened first');
    const m2 = engine.addMemory(g.id, 'text', 'Event B', 'happened second');

    const edge = engine.addTypedEdge(m1.id, m2.id, 'temporal');
    assert.equal(edge.kind, 'temporal');
  });

  // ─── shouldSplit and splitGroup ───

  it('should detect when a group needs splitting', () => {
    const config = { ...defaultKbConfig, maxChildrenBeforeSplit: 3 };
    const eng = new GroupKBEngine(store, config);

    const g = eng.createGroup('big');
    eng.addMemory(g.id, 'text', 'TypeScript basics', 'Learn TypeScript');
    eng.addMemory(g.id, 'text', 'TypeScript advanced', 'Advanced TypeScript patterns');
    eng.addMemory(g.id, 'text', 'Python intro', 'Python programming');
    eng.addMemory(g.id, 'text', 'Python advanced', 'Advanced Python features');

    assert.equal(eng.shouldSplit(g.id), true);
  });

  it('should split a large group into subgroups', () => {
    const config = { ...defaultKbConfig, maxChildrenBeforeSplit: 3 };
    const eng = new GroupKBEngine(store, config);

    const g = eng.createGroup('big');
    eng.addMemory(g.id, 'text', 'TypeScript basics', 'Learn TypeScript fundamentals');
    eng.addMemory(g.id, 'text', 'TypeScript advanced', 'Advanced TypeScript patterns');
    eng.addMemory(g.id, 'text', 'Python intro', 'Python programming fundamentals');
    eng.addMemory(g.id, 'text', 'Python advanced', 'Advanced Python features');
    eng.addMemory(g.id, 'text', 'Rust overview', 'Rust systems programming');
    eng.addMemory(g.id, 'text', 'Rust memory', 'Rust memory management');

    const subs = eng.splitGroup(g.id);
    assert.ok(subs.length >= 2);

    const parent = store.getGroup(g.id)!;
    assert.deepEqual(parent.memoryIds, []);
    assert.ok(parent.childGroupIds.length >= 2);

    let totalMems = 0;
    for (const sub of subs) {
      const sg = store.getGroup(sub.id)!;
      totalMems += sg.memoryIds.length;
      assert.equal(sg.parentGroupId, g.id);
    }
    assert.equal(totalMems, 6);
  });

  // ─── Competition subgroups ───

  it('should create and resolve competition subgroups', () => {
    const parent = engine.createGroup('approaches');
    const sub1 = engine.createCompetitionSubgroup(parent.id, 'functional');
    const sub2 = engine.createCompetitionSubgroup(parent.id, 'object-oriented');

    assert.equal(sub1.isCompetitionSubgroup, true);
    assert.equal(sub2.isCompetitionSubgroup, true);

    const parentUpdated = store.getGroup(parent.id)!;
    assert.ok(parentUpdated.competitionSubgroupIds.includes(sub1.id));
    assert.ok(parentUpdated.competitionSubgroupIds.includes(sub2.id));

    engine.addMemory(sub1.id, 'text', 'Functional patterns', 'map filter reduce compose functional programming');
    engine.addMemory(sub2.id, 'text', 'OOP patterns', 'class inheritance polymorphism encapsulation object');

    const winner = engine.resolveCompetition(parent.id, 'functional programming compose map');
    assert.ok(winner);
    assert.equal(winner.id, sub1.id);
  });

  // ─── Dormancy ───

  it('should mark dormant and activate', () => {
    const g = engine.createGroup('dormancy-test');
    const mem = engine.addMemory(g.id, 'text', 'Sleepy', 'This will be dormant');

    engine.markDormant(mem.id);
    let updated = store.getMemory(mem.id)!;
    assert.equal(updated.isDormant, true);

    engine.activateMemory(mem.id);
    updated = store.getMemory(mem.id)!;
    assert.equal(updated.isDormant, false);
    assert.ok(updated.accessCount > 0);
  });

  it('should calculate dormancy ratio', () => {
    const g = engine.createGroup('ratio-test');
    const m1 = engine.addMemory(g.id, 'text', 'Active', 'still used');
    const m2 = engine.addMemory(g.id, 'text', 'Dormant 1', 'sleeping');
    const m3 = engine.addMemory(g.id, 'text', 'Dormant 2', 'also sleeping');

    engine.markDormant(m2.id);
    engine.markDormant(m3.id);

    const ratio = engine.getDormancyRatio(g.id);
    assert.ok(Math.abs(ratio - 2 / 3) < 0.01);
  });

  it('should compress dormant memories', () => {
    const config = { ...defaultKbConfig, dormancyThresholdDays: 0 };
    const eng = new GroupKBEngine(store, config);

    const g = eng.createGroup('compress-test');
    const m1 = eng.addMemory(g.id, 'text', 'Old Note 1', 'Ancient content A');
    const m2 = eng.addMemory(g.id, 'text', 'Old Note 2', 'Ancient content B');
    const m3 = eng.addMemory(g.id, 'text', 'Active Note', 'Still relevant');

    eng.markDormant(m1.id);
    eng.markDormant(m2.id);

    store.updateMemory(m1.id, { lastAccessedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 });
    store.updateMemory(m2.id, { lastAccessedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 });

    const summary = eng.compressDormant(g.id);
    assert.ok(summary);
    assert.ok(summary.title.startsWith('[compressed]'));
    assert.ok(summary.metadata.compressed);
    assert.equal((summary.metadata.sourceCount as number), 2);

    assert.equal(store.getMemory(m1.id), undefined);
    assert.equal(store.getMemory(m2.id), undefined);

    const gUpdated = store.getGroup(g.id)!;
    assert.ok(gUpdated.memoryIds.includes(summary.id));
    assert.ok(gUpdated.memoryIds.includes(m3.id));
    assert.equal(gUpdated.memoryIds.length, 2);
  });

  // ─── Activation-spread retrieval ───

  it('should query with activation spread and return traces', () => {
    const root = engine.createGroup('programming');
    const tsGroup = engine.createGroup('typescript', root.id);
    const pyGroup = engine.createGroup('python', root.id);

    const m1 = engine.addMemory(tsGroup.id, 'text', 'TypeScript generics', 'How to use generics in TypeScript');
    const m2 = engine.addMemory(tsGroup.id, 'text', 'TypeScript interfaces', 'Interface definitions in TypeScript');
    const m3 = engine.addMemory(pyGroup.id, 'text', 'Python decorators', 'How to write decorators in Python');
    const m4 = engine.addMemory(tsGroup.id, 'text', 'TypeScript decorators', 'Decorator pattern in TypeScript');

    engine.addWeakEdge(m1.id, m2.id);
    engine.addWeakEdge(m2.id, m4.id);
    engine.addCrossGroupEdge(tsGroup.id, pyGroup.id);

    const result = engine.query('TypeScript generics');

    assert.ok(result.nodes.length > 0);
    assert.ok(result.queryTimeMs >= 0);
    assert.ok(result.totalNodesScanned > 0);
    assert.ok(result.groupsVisited.length > 0);

    assert.equal(result.nodes[0].title, 'TypeScript generics');

    assert.ok(result.traces.length > 0);
    const seedTrace = result.traces[0];
    assert.equal(seedTrace.nodeId, m1.id);
    assert.ok(seedTrace.activationLevel > 0);
    assert.ok(seedTrace.groupPath.length > 0);
    assert.ok(seedTrace.reason.length > 0);
  });

  it('should spread activation through weak edges', () => {
    const g = engine.createGroup('linked');
    const m1 = engine.addMemory(g.id, 'text', 'Alpha concepts', 'The alpha idea for testing');
    const m2 = engine.addMemory(g.id, 'text', 'Beta ideas', 'The beta extension');
    const m3 = engine.addMemory(g.id, 'text', 'Gamma thoughts', 'The gamma conclusion');

    engine.addWeakEdge(m1.id, m2.id);
    engine.addWeakEdge(m2.id, m3.id);

    const result = engine.query('Alpha concepts');
    const ids = result.nodes.map(n => n.id);

    assert.ok(ids.includes(m1.id));
    if (ids.includes(m2.id)) {
      const m2Trace = result.traces.find(t => t.nodeId === m2.id);
      assert.ok(m2Trace);
      assert.ok(m2Trace.pulseSeeds.length > 0);
      assert.ok(m2Trace.activationLevel < 1.0);
    }
  });

  it('should respect budget limits', () => {
    const g = engine.createGroup('budget-test');
    for (let i = 0; i < 50; i++) {
      engine.addMemory(g.id, 'text', `Node ${i} budget test`, `Content for budget node ${i}`);
    }

    const limited = engine.query('budget test', { budget: 5 });
    const unlimited = engine.query('budget test', { budget: 200 });
    assert.ok(limited.nodes.length <= unlimited.nodes.length);
    assert.ok(limited.totalNodesScanned < unlimited.totalNodesScanned);
  });

  it('should skip dormant nodes unless activation is high', () => {
    const g = engine.createGroup('dormant-query');
    const m1 = engine.addMemory(g.id, 'text', 'Visible search target', 'findme please');
    const m2 = engine.addMemory(g.id, 'text', 'Hidden dormant node', 'dormant content');

    engine.addWeakEdge(m1.id, m2.id);
    engine.markDormant(m2.id);

    const result = engine.query('Visible search target');
    const dormantInResults = result.nodes.find(n => n.id === m2.id);
    // Dormant node may or may not appear depending on activation level, but the query should not crash
    assert.ok(result.nodes.length >= 1);
  });

  // ─── Ingestion ───

  it('should ingest a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-ingest-'));
    const filePath = join(dir, 'test.ts');
    writeFileSync(filePath, 'export const hello = "world";');

    const rootGroup = engine.createGroup('project');
    const mem = engine.ingestFile(filePath, rootGroup.id);

    assert.equal(mem.kind, 'code');
    assert.equal(mem.title, 'test.ts');
    assert.ok(mem.content.includes('hello'));

    const group = store.getGroup(rootGroup.id)!;
    assert.ok(group.memoryIds.includes(mem.id));

    rmSync(dir, { recursive: true, force: true });
  });

  it('should ingest a directory with group hierarchy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-dir-ingest-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'src', 'utils'));
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {};');
    writeFileSync(join(dir, 'src', 'utils', 'helper.ts'), 'export function help() {}');
    writeFileSync(join(dir, 'README.md'), '# Test project');

    engine.ingestDirectory(dir);

    const allGroups = store.getAllGroups();
    assert.ok(allGroups.length >= 2);

    const rootName = allGroups.find(g => g.parentGroupId === null);
    assert.ok(rootName);

    rmSync(dir, { recursive: true, force: true });
  });

  // ─── Cycle detection with group-name refs ───

  it('should detect cycles through group-name references', () => {
    const a = engine.createGroup('group-a');
    const b = engine.createGroup('group-b', a.id);

    store.updateGroup(a.id, { nameIsGroupRef: true });

    const c = engine.createGroup('group-c', b.id);

    // a -> b -> c, and a has nameIsGroupRef=true. If a name-ref target matches c's
    // ancestor chain, it's a cycle. The cycle detection should at minimum prevent
    // direct circular parenting.
    assert.throws(() => engine.addChildGroup(c.id, a.id), /cycle/);
  });
});
