/*
 * 组（DAG）与"知识向上冒泡"的判据。
 *
 * 三条要守住的语义：
 *  ① 一个文件可以同时属于多个组（目录轴 + 包轴 + 层轴 + 功能轴），不是树；
 *  ② 挂在祖先目录上的知识，查文件时必须浮上来，而且必须标明"来自上层"；
 *  ③ 候选绑定不许没有反证条件 —— 否则"潜在威胁"会变成一堆无法否证的噪音。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveGroups, ancestorDirs, groupContains, linkKb, kbLinksFor } from '../index.js';

const views = {
  packages: [
    { name: '@she/ui', root: 'packages/ui', kind: 'npm' as const, manifest: 'packages/ui/package.json' },
    { name: '@she/kb', root: 'packages/kb', kind: 'npm' as const, manifest: 'packages/kb/package.json' },
  ],
  repos: [],
  targets: [],
  primary: 'package' as const,
  evidence: ['test'],
};

test('组是 DAG：同一个文件同时属于目录轴、包轴、层轴', () => {
  const g = deriveGroups('packages/ui/src/components/Chat.tsx', views);
  assert.ok(g.includes('dir:packages/ui/src/components'), '目录轴：所在目录');
  assert.ok(g.includes('dir:packages/ui'), '目录轴：祖先目录');
  assert.ok(g.includes('pkg:@she/ui'), '包轴');
  assert.ok(g.includes('layer:ui'), '层轴');
  assert.ok(g.length > 5, `至少 5 个组（实际 ${g.length}）`);
});

test('测试文件横切各包，归到 layer:test', () => {
  const g = deriveGroups('packages/kb/src/__tests__/compaction.test.ts', views);
  assert.ok(g.includes('layer:test'), '测试是一层，不是一包');
  assert.ok(g.includes('pkg:@she/kb'), '但它同时仍属于所在包');
});

test('groupContains：目录组按路径前缀包含', () => {
  assert.equal(groupContains('dir:packages/ui', 'dir:packages/ui/src'), true);
  assert.equal(groupContains('dir:packages/ui', 'dir:packages/uikit'), false);
  assert.equal(groupContains('dir:.', 'dir:anything/deep'), true);
  assert.equal(groupContains('pkg:a', 'dir:a'), false, '不同轴不互相包含');
});

test('祖先冒泡：挂在目录上的知识，查文件时会浮上来并标明来自上层', () => {
  const root = mkdtempSync(join(tmpdir(), 'she-bind-'));
  try {
    linkKb(root, 'main', {
      path: 'packages/ui',
      kbGroup: 'architecture/ui',
      kbNodeId: 'n1',
      title: 'UI 的样式 token 与主题约定',
      confidence: 'certain',
      evidence: ['用户 2026-10-17 明确：白板/主题不许用 --bg-*'],
    });
    linkKb(root, 'main', {
      path: 'packages/ui/src/components/Chat.tsx',
      kbGroup: 'architecture/ui',
      kbNodeId: 'n2',
      title: 'Chat 的跟随规则',
      confidence: 'certain',
      evidence: ['提交 e0679dd'],
    });

    const links = kbLinksFor(root, 'main', 'packages/ui/src/components/Chat.tsx');
    assert.equal(links.length, 2, '文件自己 + 祖先目录各一条');
    assert.equal(links[0]!.kbNodeId, 'n2', '确定命中排在前，且文件优先于祖先');
    const bubbled = links.find((l) => l.kbNodeId === 'n1');
    assert.ok(bubbled, '祖先的知识必须浮上来');
    assert.equal(bubbled!.fromAncestor, true, '必须标明来自上层');
    assert.equal(bubbled!.via, 'packages/ui', 'via 指向真正挂载的目录');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('关闭冒泡时只看文件自己', () => {
  const root = mkdtempSync(join(tmpdir(), 'she-bind2-'));
  try {
    linkKb(root, 'main', {
      path: 'packages/ui',
      kbGroup: 'architecture/ui',
      title: '目录级知识',
      confidence: 'certain',
      evidence: ['x'],
    });
    const links = kbLinksFor(root, 'main', 'packages/ui/src/a.ts', { includeAncestors: false });
    assert.equal(links.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('候选绑定没有反证条件 → 拒绝写入', () => {
  const root = mkdtempSync(join(tmpdir(), 'she-bind3-'));
  try {
    assert.throws(
      () => linkKb(root, 'main', { path: 'a.ts', kbGroup: 'g', title: 't', confidence: 'candidate', evidence: ['字面命中 "a.ts"'] }),
      /candidate/,
      '候选必须带 evidence + falsifiers',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ancestorDirs：由近到远，含 .', () => {
  assert.deepEqual(ancestorDirs('a/b/c.ts'), ['a/b', 'a', '.']);
});
