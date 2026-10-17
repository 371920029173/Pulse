/*
 * 按评测修的三处，各写一条判据钉住：
 *  ① 包装函数（withSid('/api/chat')）也算调用 → 主聊天 API 不再被判"没有调用方"；
 *  ② 方法写在下一行也要认；
 *  ③ 纯类型导入要能区分（影响面分"重编译"与"会运行出错"两组）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanHttpContracts, scanImports } from '../index.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'she-eval-'));
}

test('包装函数：withSid(\'/api/chat\') 算一次调用，主聊天 API 不再是死路由', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'server'), { recursive: true });
    mkdirSync(join(dir, 'ui'), { recursive: true });
    writeFileSync(join(dir, 'server', 'routes.ts'), "router.post('/api/chat', h);\nrouter.get('/api/chat/running', h);\n");
    /* 真实写法：路径交给本地 helper。 */
    writeFileSync(join(dir, 'ui', 'chat.ts'), "const withSid = (p: string) => `${p}?sid=1`;\nfetchJSON(withSid('/api/chat'));\nfetch(withSid('/api/chat/running'));\n");

    const res = scanHttpContracts(dir, [{ path: 'server/routes.ts' }, { path: 'ui/chat.ts' }]);
    assert.equal(res.certain, 2, `两条都应识别成调用（实际 ${res.certain}）`);
    assert.equal(res.threats, 0, '主聊天 API 不该再被报成"没有调用方"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('路由注册行不会被当成调用（否则每条路由都给自己配一个调用方）', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'server'), { recursive: true });
    writeFileSync(join(dir, 'server', 'routes.ts'), "router.get('/api/only-server', h);\n");
    const res = scanHttpContracts(dir, [{ path: 'server/routes.ts' }]);
    assert.equal(res.certain, 0);
    assert.equal(res.threats, 1, '只有提供端 → 一条潜在威胁，不是"自己调用自己"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('方法写在下一行也认；纯类型导入单独标记', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'server'), { recursive: true });
    mkdirSync(join(dir, 'ui'), { recursive: true });
    writeFileSync(join(dir, 'server', 'routes.ts'), "router.put('/api/settings', h);\n");
    writeFileSync(join(dir, 'ui', 'api.ts'), "fetchJSON(\n  '/api/settings',\n  { method: 'PUT' },\n);\n");
    writeFileSync(join(dir, 'ui', 'types.ts'), "import type { LLMMessage } from '@she/shared';\nimport { budgetToolResult } from '@she/shared';\n");

    const res = scanHttpContracts(dir, [{ path: 'server/routes.ts' }, { path: 'ui/api.ts' }]);
    assert.equal(res.certain, 1, 'PUT 写在下一行也要对上');

    const imports = scanImports(dir, [{ path: 'ui/types.ts', lang: 'ts' }], [{ name: '@she/shared', root: 'ui' }]);
    const typeEdges = imports.edges.filter((e) => e.edge.typeOnly);
    assert.equal(typeEdges.length, 1, 'import type 要标 typeOnly');
    assert.equal(imports.edges.length - typeEdges.length, 1, '值导入不标');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
