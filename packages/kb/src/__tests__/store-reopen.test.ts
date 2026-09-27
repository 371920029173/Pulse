/**
 * A store that somebody closed behind its holder's back.
 *
 * `KBStore` is shared and long-lived: an Agent is built with the engine for its session's directory
 * and keeps that reference for the whole session, while the store itself can be closed by lifecycle
 * events that know nothing about that agent — remounting the knowledge base when the workspace or
 * the KB path changes, `share`/`merge` releasing the file before copying it, and worktree cleanup
 * letting go of the handle so Windows can delete the directory.
 *
 * Every one of those left the agent calling a released connection, and better-sqlite3 answers that
 * with a bare `The database connection is not open` on every subsequent call, permanently, with no
 * way back short of restarting the process. That is not hypothetical: on 2026-09-27 a workspace
 * switch at 16:34 did exactly this to a then 14-hour-old session, and for the rest of the day
 * `kb_query`, `kb_upsert`, `kb_edit` and `errorbook_lookup` all failed that way while the UI — which
 * reads the freshly mounted store — looked perfectly healthy. The report read as a corrupted
 * database; it was a closed handle.
 *
 * These tests pin the reopen, and the state that must NOT survive it (cached statements belong to
 * the connection that prepared them).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KBStore } from '../store.js';
import { GroupKBEngine } from '../engine.js';
import type { SheConfig } from '@she/shared';

const KB: SheConfig['kb'] = {
  dbPath: '',
  maxChildrenBeforeSplit: 12,
  dormancyThresholdDays: 30,
  activationBudget: 100,
  boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
};

describe('KBStore after its connection is closed by somebody else', () => {
  let dir: string;
  let dbPath: string;
  let store: KBStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'she-kb-reopen-'));
    dbPath = join(dir, 'kb.sqlite');
    store = new KBStore(dbPath);
  });

  afterEach(() => {
    try { store.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports isOpen honestly, and comes back on first use', () => {
    assert.equal(store.isOpen, true);
    assert.equal(store.reopenCount, 0);

    store.close();
    assert.equal(store.isOpen, false);

    store.getAllGroups();
    assert.equal(store.isOpen, true);
    assert.equal(store.reopenCount, 1);
  });

  it('still reads the data it had before the close', () => {
    const group = store.createGroup({ name: 'survivor' });
    store.close();

    const groups = store.getAllGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].id, group.id);
    assert.equal(groups[0].name, 'survivor');
  });

  it('writes to the same file after the close (a second connection sees both writes)', () => {
    store.createGroup({ name: 'before' });
    store.close();
    store.createGroup({ name: 'after' });

    const fresh = new KBStore(dbPath);
    try {
      assert.deepEqual(
        fresh.getAllGroups().map((g) => g.name).sort(),
        ['after', 'before'],
      );
    } finally {
      fresh.close();
    }
  });

  it('does not reuse prepared statements from the closed connection', () => {
    const group = store.createGroup({ name: 'reused' });
    // Warm the statement cache for these exact statements on the old connection...
    assert.equal(store.getAllGroups().length, 1);

    store.close();

    // ...then run them again. A Statement belonging to the dead connection throws here.
    assert.equal(store.getAllGroups().length, 1);
    assert.equal(store.getGroup(group.id)?.name, 'reused');
    assert.equal(store.reopenCount, 1);
  });

  it('keeps transactions working, including rollback', () => {
    store.close();
    assert.throws(() =>
      store.transaction(() => {
        store.createGroup({ name: 'rolled-back' });
        throw new Error('boom');
      }));
    assert.equal(store.getAllGroups().length, 0);
    assert.equal(store.isOpen, true);
  });

  /**
   * The shape the server actually has: the Agent holds the engine, the remount closes the store the
   * engine was built with, and the agent goes on using it.
   */
  it('keeps working for a caller that captured the engine', () => {
    const engine = new GroupKBEngine(store, KB);
    const group = engine.createGroup('live');

    // One workspace switch / merge / worktree cleanup is exactly this line.
    store.close();

    const memory = engine.addMemory(group.id, 'text', 'written after the close', 'still here');
    assert.ok(memory.id);
    assert.equal(store.getMemory(memory.id)?.title, 'written after the close');
    assert.equal(store.reopenCount, 1);
  });
});
