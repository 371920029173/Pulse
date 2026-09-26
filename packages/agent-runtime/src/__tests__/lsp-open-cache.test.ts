import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWN_SERVERS, resolveServer, LspServer } from '../lsp-client.js';

/*
 * Regression: a file first opened by a structural query must not make diagnostics time out.
 *
 * The open-time publish used to be cached against '' instead of the opened text, so
 * `diagnosticsFor` with unchanged text missed the cache and waited 15s for a re-publish that
 * typescript-language-server never sends. Three identical timeouts then tripped the stuck-loop
 * guard and ended a live turn (seen in _she-live-test on 2026-09-25).
 */
describe('lsp: diagnostics after a structural query', () => {
  const spec = KNOWN_SERVERS.find((s) => s.id === 'typescript');
  const root = mkdtempSync(join(tmpdir(), 'she-lsp-'));
  const launch = spec ? resolveServer(spec, root) : null;

  it('answers from the open-time publish instead of timing out', { skip: !launch, timeout: 30_000 }, async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src/**/*.ts'] }));
    writeFileSync(join(root, 'src', 'types.ts'), 'export interface Point { x: number; y: number }\n');
    const text = 'import type { Point } from "./types";\nexport function len(p: Point): number {\n  return p.x + p.y;\n}\n';
    const file = join(root, 'src', 'main.ts');
    writeFileSync(file, text);
    const srv = new LspServer(spec!, root, launch!);
    try {
      await srv.start();
      await srv.definition(file, 'typescript', text, { line: 1, character: 20 });
      const t = Date.now();
      const diags = await srv.diagnosticsFor(file, 'typescript', text);
      assert.notEqual(diags, null, 'diagnostics timed out');
      assert.deepEqual(diags, []);
      assert.ok(Date.now() - t < 5_000, `took ${Date.now() - t}ms`);
    } finally {
      await srv.stop().catch(() => undefined);
      // Windows keeps the dir locked briefly after the server exits; a leftover temp dir is harmless.
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
    }
  });
});
