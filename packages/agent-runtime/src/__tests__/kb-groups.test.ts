/**
 * kb_groups 的判据：地图要**看得懂、指得准、指错了能纠正**。
 *
 * 用户提议（2026-10-13）：「告诉它什么东西可能在哪里」——在这之前模型的 KB 工具没有任何"看树"的
 * 办法，这一条就是那个缺口的判据：空库要说清是空的、概览要有条数与最近写入、钻进去要能看到子组与
 * 自己的记忆、组名写错要给相近的名字（而不是一句"没有"）。
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

describe('kb_groups：知识树的地图', () => {
  let dir: string;
  let store: KBStore;
  let engine: GroupKBEngine;
  let tools: ReturnType<typeof createKBTools>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'she-kb-groups-'));
    store = new KBStore(join(dir, 'kb.sqlite'));
    engine = new GroupKBEngine(store, kbConfig);
    tools = createKBTools(engine);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (args: Record<string, unknown> = {}) => tools.execute('kb_groups', args);
  const write = (groupName: string, title: string) =>
    tools.execute('kb_upsert', { groupName, title, content: `${title} 的正文` });

  it('空库：说清是空的，并给出下一步（不是一张空表）', async () => {
    const out = await run();
    assert.match(out, /还是空的/, '空库没有说清楚');
    assert.match(out, /kb_upsert/, '空库没有告诉它下一步怎么做');
  });

  it('工具清单里有 kb_groups（模型才可能去用；不然只是代码里有）', () => {
    assert.ok(tools.definitions.some((d) => d.name === 'kb_groups'), 'kb_groups 没有注册进工具表');
  });

  it('概览：顶层 + 第二层，带条数与最近写入的日期', async () => {
    await write('project/alpha/lessons', 'A');
    await write('project/alpha/findings', 'B');
    await write('host/windows', 'C');

    const out = await run();
    assert.match(out, /知识树：\d+ 条路径 \/ \d+ 个组/, '没有给出组数/路径数');
    assert.match(out, /- project/, '缺少 project');
    assert.match(out, /- host\/windows/, '第二层没有列出来');
    assert.match(out, /\d+ 条（最近 \d{2}-\d{2}）/, '条数或最近写入没写出来');
    assert.match(out, /path=/, '没有告诉它怎么钻进去');
  });

  it('钻进去：子组 + 本组自己的记忆（标题 + node id）', async () => {
    await write('project/alpha/lessons', 'LESSON-TITLE');
    const out = await run({ path: 'project/alpha' });
    assert.match(out, /project\/alpha：/, '没有钻到那个组');
    assert.match(out, /lessons/, '子组没列出来');
  });

  it('本组自己有记忆时，直接列出标题与 node id（能接着 kb_get 原文）', async () => {
    await write('project/alpha', 'DIRECT-TITLE');
    const out = await run({ path: 'project/alpha' });
    assert.match(out, /DIRECT-TITLE/);
    assert.match(out, /\[Node: /);
  });

  it('组名写错：给相近的名字，而不是一句"没有"', async () => {
    await write('project/alpha/lessons', 'A');
    const out = await run({ path: 'project/alp' });
    assert.match(out, /没有叫/, '没有明确说这个组不存在');
    assert.match(out, /project\/alpha/, '没有给出相近的组名');
  });
});
