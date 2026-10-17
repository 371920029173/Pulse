/*
 * 契约图的判据（用户提的"创建时记录潜在依赖 → 两端对账 → 确定/潜在威胁"）。
 *
 * 要守住的三条：
 *  ① 两端都在 → certain，并且证据要指到两边的具体行（"谁能复核"）；
 *  ② 只有使用端 / 只有提供端 → candidate + threat，**必须带 falsifiers**；
 *  ③ 路径规范化：路由 `:id` 与 fetch 模板 `${id}` 要能对上，否则全是假威胁。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractRoutes, extractFetches, normalizePath, scanHttpContracts } from '../index.js';

test('规范化：模板串与 :param 视作同一路径', () => {
  assert.equal(normalizePath('`/api/sessions/${id}/move`'), '/api/sessions/:param/move');
  assert.equal(normalizePath("'/api/sessions/:id/move'"), '/api/sessions/:id/move');
});

test('抽取：router.get/post 与 fetchJSON 都认得，行号正确', () => {
  const server = ["router.get('/api/health', h);", "router.post('/api/sessions/:id/move', h);"].join('\n');
  const routes = extractRoutes(server, 'srv.ts');
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), ['GET /api/health', 'POST /api/sessions/:id/move']);
  assert.equal(routes[0]!.line, 1);

  const ui = ["const a = await fetchJSON('/api/health');", "await fetchJSON(`/api/sessions/${id}/move`, { method: 'POST' });"].join('\n');
  const fetches = extractFetches(ui, 'ui.ts');
  assert.equal(fetches.length, 2);
  assert.equal(fetches[1]!.method, 'POST');
  assert.equal(normalizePath(fetches[1]!.path), '/api/sessions/:param/move');
});

test('对账：两端都在 → certain，证据指到两边', () => {
  const dir = mkdtempSync(join(tmpdir(), 'she-contract-'));
  try {
    mkdirSync(join(dir, 'server'), { recursive: true });
    mkdirSync(join(dir, 'ui'), { recursive: true });
    writeFileSync(join(dir, 'server', 'routes.ts'), "router.get('/api/health', h);\n");
    writeFileSync(join(dir, 'ui', 'api.ts'), "fetchJSON('/api/health');\n");

    const res = scanHttpContracts(dir, [{ path: 'server/routes.ts' }, { path: 'ui/api.ts' }]);
    assert.equal(res.certain, 1);
    const edge = res.edges.find((e) => e.edge.confidence === 'certain')!.edge;
    assert.equal(edge.from, 'ui/api.ts');
    assert.equal(edge.to, 'server/routes.ts');
    assert.ok(edge.evidence.some((e) => e.includes('ui/api.ts:1')), '证据要指到调用点');
    assert.ok(edge.evidence.some((e) => e.includes('server/routes.ts:1')), '证据要指到路由定义');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('对账：只有使用端 / 只有提供端 → candidate + 反证条件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'she-contract2-'));
  try {
    mkdirSync(join(dir, 'server'), { recursive: true });
    mkdirSync(join(dir, 'ui'), { recursive: true });
    writeFileSync(join(dir, 'server', 'routes.ts'), "router.get('/api/only-server', h);\n");
    writeFileSync(join(dir, 'ui', 'api.ts'), "fetchJSON('/api/only-client');\n");

    const res = scanHttpContracts(dir, [{ path: 'server/routes.ts' }, { path: 'ui/api.ts' }]);
    assert.equal(res.certain, 0);
    assert.equal(res.threats, 2, '两边各一条潜在威胁');
    for (const { edge } of res.edges) {
      assert.equal(edge.confidence, 'candidate');
      assert.ok((edge.falsifiers ?? []).length > 0, '候选必须带反证条件');
      assert.ok(edge.evidence.length > 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
