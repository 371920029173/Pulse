/*
 * P7.5 的判据：逐段匹配真正压掉的是两类假威胁，这里各测一条。
 * 另外要守住反向：**不该匹配的绝不能匹配**，否则假阴性会变成假阳性（更危险）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { segmentsMatch, scanHttpContracts } from '../index.js';

test('segmentsMatch：参数位可被具体值填上', () => {
  assert.equal(segmentsMatch('/api/sessions/:id', '/api/sessions/sess_x'), true);
  assert.equal(segmentsMatch('/api/sessions/:id/move', '/api/sessions/:param/move'), true);
  assert.equal(segmentsMatch('/api/health', '/api/health'), true);
});

test('segmentsMatch：末尾 ${q} 那种段不参与对齐', () => {
  assert.equal(segmentsMatch('/api/audit', '/api/audit/:param'), true);
  assert.equal(segmentsMatch('/api/runs', '/api/runs/:param'), true);
});

test('segmentsMatch：不该匹配的绝不匹配（假阳性比假阴性更危险）', () => {
  assert.equal(segmentsMatch('/api/sessions/:id', '/api/core'), false);
  assert.equal(segmentsMatch('/api/sessions/:id/close', '/api/sessions/sess_x'), false, '段数不同且末段不是参数');
  assert.equal(segmentsMatch('/api/health', '/api/healthcheck'), false);
});

test('对账：具体 id 的调用现在算确定，而不是潜在威胁', () => {
  const dir = mkdtempSync(join(tmpdir(), 'she-seg-'));
  try {
    mkdirSync(join(dir, 'server'), { recursive: true });
    mkdirSync(join(dir, 'ui'), { recursive: true });
    writeFileSync(join(dir, 'server', 'routes.ts'), "router.get('/api/sessions/:id', h);\nrouter.get('/api/audit', h);\n");
    writeFileSync(join(dir, 'ui', 'api.ts'), "fetchJSON('/api/sessions/sess_x');\nfetchJSON(`/api/audit${q}`);\n");

    const res = scanHttpContracts(dir, [{ path: 'server/routes.ts' }, { path: 'ui/api.ts' }]);
    assert.equal(res.certain, 2, '两条都该对上');
    assert.equal(res.threats, 0, '不该再有假威胁');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
