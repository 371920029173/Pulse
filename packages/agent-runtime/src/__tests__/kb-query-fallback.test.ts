/**
 * kb_query 的「兜底匹配」：引擎主检索把握不足时给出的第二遍结果，必须和真正的命中分开、带标签、
 * 附上怎么问得更准 —— 否则 agent 会把一个字面巧合当成记忆引用。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KBStore, GroupKBEngine } from '@she/kb';
import type { MemoryNode } from '@she/shared';
import { createKBTools } from '../kb-tools.js';

function node(id: string, title: string, content: string): MemoryNode {
  return {
    id, kind: 'fact', title, content, metadata: {}, groupIds: [], accessCount: 0,
    lastAccessedAt: 0, createdAt: 0, updatedAt: 0, isDormant: false,
  } as unknown as MemoryNode;
}

function engineReturning(result: Record<string, unknown>): GroupKBEngine {
  return {
    store: { getAllGroups: () => [] },
    query: () => ({ traces: [], groupsVisited: [], queryTimeMs: 0, totalNodesScanned: 0, pulseSeeds: [], ...result }),
  } as unknown as GroupKBEngine;
}

const fallback = {
  nodes: [node('fb1', '数据库 migration 脚本', '迁移脚本放在 db/ 下'.repeat(20))],
  traces: [{ nodeId: 'fb1', groupPath: ['project'], pulseSeeds: [], activationLevel: 0, reason: 'fallback n-gram overlap 0.40: mig' }],
  reason: '主检索没有命中',
};

describe('kb_query 兜底匹配', () => {
  it('主检索为空时，兜底结果带「兜底匹配」标签和改问建议，而不是只回 No results', async () => {
    const tools = createKBTools(engineReturning({ nodes: [], fallback }));
    const out = await tools.execute('kb_query', { query: 'migrat' });
    assert.match(out, /^No results found in Group KB\./, '主结果为空这一事实必须照说');
    assert.match(out, /「兜底匹配」主检索没有命中/);
    assert.match(out, /换更具体的词/);
    assert.match(out, /\[兜底 1\] 数据库 migration 脚本/);
    assert.match(out, /\[Node: fb1\]/);
    assert.ok(out.includes('…'), '兜底条目的正文只给短摘要');
  });

  it('有主结果时兜底列在后面，主结果编号不被占用', async () => {
    const tools = createKBTools(engineReturning({
      nodes: [node('p1', '项目总览', '这是项目的总体说明')],
      traces: [{ nodeId: 'p1', groupPath: ['project'], pulseSeeds: [], activationLevel: 1, reason: '', finalScore: 0.9 }],
      fallback: { ...fallback, reason: '主检索最佳结果只覆盖查询词的 10%' },
    }));
    const out = await tools.execute('kb_query', { query: '项目 migrat' });
    assert.ok(out.indexOf('[1] 项目总览') < out.indexOf('「兜底匹配」'), '兜底必须在真正的命中之后');
    assert.match(out, /覆盖查询词的 10%/);
  });

  it('没有兜底时输出与原来逐字一致（不多付一个 token）', async () => {
    const tools = createKBTools(engineReturning({ nodes: [] }));
    assert.equal(await tools.execute('kb_query', { query: 'x' }), 'No results found in Group KB.');
  });

  it('接真实引擎：意义型查询命中错题本，字面巧合只进兜底', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'she-kb-fallback-'));
    const dbPath = join(dir, 'kb.sqlite');
    const store = new KBStore(dbPath);
    try {
      const engine = new GroupKBEngine(store, {
        dbPath, maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100, boostOnAccess: 1.5,
        pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
      });
      const errors = engine.createGroup('errors');
      const fsRead = engine.createGroup('fs_read', errors.id);
      const project = engine.createGroup('project');
      engine.addMemory(fsRead.id, 'fact', 'fs_read · not_found', '工具：fs_read｜失败类型：not_found｜去路：先 fs_list 确认路径');
      engine.addMemory(project.id, 'fact', '项目记录：数据库 migration 脚本', '迁移脚本放在 db/ 下');
      const tools = createKBTools(engine);

      const meaning = await tools.execute('kb_query', { query: '怎样才能不再犯同样的错误' });
      assert.match(meaning, /\[1\] fs_read · not_found/);
      assert.doesNotMatch(meaning, /兜底匹配/, '主检索有把握时不该附兜底');

      const weak = await tools.execute('kb_query', { query: 'migrat' });
      assert.match(weak, /^No results found in Group KB\./);
      assert.match(weak, /\[兜底 1\] 项目记录：数据库 migration 脚本/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
