import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWN_SERVERS, resolveServer, LspServer } from '../lsp-client.js';

/*
 * Workspace roots are created at file scope (the paths appear in assertions) and every one of them
 * is removed when the file finishes — including a root created for a test that then got SKIPPED,
 * which no `try/finally` inside the test can cover.
 *
 * This used to leak one directory per run: the root was removed while the language server still held
 * it open, the EBUSY went into a `catch`, and `LspServer.stop()` did not wait for the process to
 * actually exit. That is fixed at the source — `stop()` now waits for `exit` — but the removal here
 * still retries, because Windows releases the handle slightly after the process reports exit.
 */
const roots: string[] = [];
function lspRoot(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}
after(async () => {
  for (const root of roots) {
    for (let attempt = 0; attempt < 12; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => { setTimeout(r, 250); }); }
    }
  }
});

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
  const root = lspRoot('she-lsp-');
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
      // Now actually waits for the server process to be gone, which is what makes the `after` hook
      // above able to delete `root`.
      await srv.stop().catch(() => undefined);
    }
  });
});
