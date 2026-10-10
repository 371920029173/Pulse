/**
 * 记忆激活账（`activationReport`）。
 *
 * 为什么要有它：`accessCount` / `lastAccessedAt` 一直在维护（检索命中就会加一），但从来没有一次
 * 成批把它们读回来 —— 「哪些知识真的在被用」没有答案，清理只能凭感觉，也看不见一个节点在变凉之前
 * 的样子。这里钉三件事：
 *   1. 被检索命中的节点进 `hot`，按访问次数排序；
 *   2. 从没被访问过的被数进 `neverAccessed`，并出现在 `cold` 里；
 *   3. `now` 可注入 —— 时间是判据的一部分，不能靠等。
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KBStore } from '../store.js';
import { GroupKBEngine } from '../engine.js';
import { activationReport } from '../activation.js';
import type { SheConfig } from '@she/shared';

/*
 * 每个用例一个新库、一个新的临时目录，并**记住**它 —— 这仓库为"临时目录不清理"付过代价
 * （一次排查在 TEMP 下发现几千个残留目录）。
 */
const dirs: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'she-kb-act-'));
  dirs.push(dir);
  return join(dir, 'kb.sqlite');
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const cfg: SheConfig['kb'] = {
  dbPath: '',
  maxChildrenBeforeSplit: 12,
  dormancyThresholdDays: 30,
  activationBudget: 100,
  boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
};

describe('记忆激活账', () => {
  it('被用到的进 hot，从没用过的进 neverAccessed 与 cold', () => {
    const store = new KBStore(tmpDb());
    const engine = new GroupKBEngine(store, cfg);
    const g = engine.createGroup('act/demo');
    const used = engine.addMemory(g.id, 'fact', 'signpost-freeze', 'sentinel keyword ZEBRA-PORT');
    const unused = engine.addMemory(g.id, 'fact', 'never-queried', 'nobody has asked for this');
    for (let i = 0; i < 3; i++) engine.activateMemory(used.id);

    // 时间注入：判据不靠等。
    const r = activationReport(store, { now: Date.now() + 5 * 86_400_000 });

    assert.equal(r.total, 2);
    assert.equal(r.neverAccessed, 1, `应当恰好有一个从没被访问过: ${JSON.stringify(r)}`);
    assert.equal(r.hot[0]?.id, used.id, `hot 第一条应当是访问最多的那个: ${JSON.stringify(r.hot)}`);
    assert.equal(r.hot[0]?.accessCount, 3);
    assert.ok(r.cold.some((x) => x.id === unused.id), '从没被访问过的应当出现在 cold 里');
    assert.ok(r.cold.some((x) => x.id === used.id), '五天没碰过，用过的也会变冷');
    assert.ok(r.hot.every((x) => x.accessCount > 0), 'hot 里不该有访问次数为 0 的');
    store.close();
  });

  it('窗口大小可调，且不会因为空库炸掉', () => {
    const store = new KBStore(tmpDb());
    const engine = new GroupKBEngine(store, cfg);
    const empty = activationReport(store, { hot: 3, cold: 2 });
    assert.deepEqual([empty.total, empty.neverAccessed, empty.hot.length, empty.cold.length], [0, 0, 0, 0]);

    const g = engine.createGroup('act/many');
    for (let i = 0; i < 5; i++) engine.addMemory(g.id, 'fact', `n${i}`, `body ${i}`);
    const r = activationReport(store, { hot: 3, cold: 2 });
    assert.equal(r.total, 5);
    assert.equal(r.neverAccessed, 5);
    assert.equal(r.hot.length, 0, '没有任何访问记录时 hot 为空（而不是把冷节点冒充成热的）');
    assert.equal(r.cold.length, 2);
    store.close();
  });
});
