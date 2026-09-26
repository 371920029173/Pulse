/**
 * Writes never land in a split part (`<group>/part-N`): kb_upsert and ingest placement redirect
 * to the logical group, and ingest lists only logical groups as placement targets.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KBStore, GroupKBEngine } from '@she/kb';
import type { SheConfig } from '@she/shared';
import { createKBTools } from '../kb-tools.js';
import { createIngestTools } from '../ingest-tools.js';

const kbConfig: SheConfig['kb'] = {
  dbPath: '',
  maxChildrenBeforeSplit: 12,
  dormancyThresholdDays: 30,
  activationBudget: 100,
  boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
};

const LOGICAL = 'project/she-live-test';
const PART3 = `${LOGICAL}/part-3`;

describe('split-part write redirect', () => {
  let dir: string;
  let store: KBStore;
  let engine: GroupKBEngine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'she-split-redirect-'));
    store = new KBStore(join(dir, 'kb.sqlite'));
    engine = new GroupKBEngine(store, kbConfig);
    const logical = engine.createGroup(LOGICAL);
    for (let i = 0; i < 13; i++) engine.addMemoryMaintained(logical.id, 'fact', `seed ${i}`, `seed content ${i}`);
    assert.ok(store.getAllGroups().some((g) => g.name === PART3), 'fixture: logical group already split');
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const group = (name: string) => store.getAllGroups().find((g) => g.name === name)!;

  it('kb_upsert into a split part writes to the logical group and says so', async () => {
    const tools = createKBTools(engine);
    const out = await tools.execute('kb_upsert', { groupName: PART3, title: 'redirect me', content: 'body' });
    assert.match(out, /^Added memory "redirect me" to group "project\/she-live-test"/);
    assert.match(out, /redirected from split part "project\/she-live-test\/part-3"/);
    const logical = group(LOGICAL);
    const [mem] = store.getMemoriesByGroup(logical.id);
    assert.equal(mem.title, 'redirect me');
    assert.ok(!group(PART3).memoryIds.includes(mem.id));
  });

  it('repeated kb_upsert into a part never produces nested part groups', async () => {
    const tools = createKBTools(engine);
    for (let i = 0; i < 30; i++) {
      await tools.execute('kb_upsert', { groupName: PART3, title: `note ${i}`, content: `c ${i}` });
    }
    const names = store.getAllGroups().map((g) => g.name);
    assert.ok(!names.some((n) => /\/part-\d+\/part-/.test(n)), names.join(', '));
    assert.equal(new Set(names).size, names.length);
  });

  it('ingest lists logical groups only and redirects placement into a part', async () => {
    const ws = join(dir, 'ws');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(ws);
    writeFileSync(join(ws, 'notes.md'), '# Alpha\nalpha body text\n');
    const tools = createIngestTools(ws, engine, store);
    await tools.execute('kb_ingest_scan', { path: 'notes.md' });

    const list = await tools.execute('kb_ingest_list', {});
    assert.ok(!/part-\d/.test(list), list);
    assert.ok(list.includes(LOGICAL));
    const itemId = list.match(/^\s+(\S+)\s+Alpha/m)?.[1];
    assert.ok(itemId, list);

    const out = await tools.execute('kb_ingest_place', { item_id: itemId, groupName: PART3 });
    assert.match(out, /redirected from split part/);
    const logical = group(LOGICAL);
    assert.equal(store.getMemoriesByGroup(logical.id).length, 1);
  });
});