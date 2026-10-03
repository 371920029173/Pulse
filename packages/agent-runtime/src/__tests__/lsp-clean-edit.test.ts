import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWN_SERVERS, resolveServer, LspServer } from '../lsp-client.js';

/*
 * Workspace roots, removed when the file finishes — including a root created for a test that then
 * got SKIPPED, which no `try/finally` inside it can cover. See `lsp-open-cache.test.ts` for why this
 * used to leak one directory per run; briefly, `stop()` did not wait for the server process to exit,
 * so the removal raced a process that still held the directory, and the EBUSY went into a `catch`.
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
 * Regression: an edit that keeps a file clean must not make diagnostics time out.
 *
 * typescript-language-server does not re-publish when the diagnostic set is unchanged
 * (empty before, empty after), so `didChange` alone waited the full 15s and reported
 * "no answer". Seen on qa/hard/geometry.ts in _she-scratch on 2026-09-26: lsp_hover,
 * then fs_write, then lsp_diagnostics timed out while tsc was fine.
 */
describe('lsp: diagnostics after a clean-to-clean edit', () => {
  const spec = KNOWN_SERVERS.find((s) => s.id === 'typescript');
  const root = lspRoot('she-lsp-edit-');
  const launch = spec ? resolveServer(spec, root) : null;

  it('answers for clean, erroring and re-cleaned edits', { skip: !launch, timeout: 60_000 }, async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src/**/*.ts'] }));
    writeFileSync(join(root, 'src', 'types.ts'), 'export interface Point { x: number; y: number }\n');
    const t0 = 'import type { Point } from "./types";\nexport function d(a: Point, b: Point): number {\n  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);\n}\n';
    const t1 = 'import type { Point } from "./types";\nexport function d(a: Point, b: Point): number {\n  const dx = a.x - b.x, dy = a.y - b.y;\n  return Math.sqrt(dx * dx + dy * dy);\n}\n';
    const t2 = t1 + 'export const bad: number = "x";\n';
    const file = join(root, 'src', 'geometry.ts');
    writeFileSync(file, t0);
    const srv = new LspServer(spec!, root, launch!);
    try {
      await srv.start();
      await srv.hover(file, 'typescript', t0, { line: 1, character: 17 });

      writeFileSync(file, t1);
      const clean = await srv.diagnosticsFor(file, 'typescript', t1);
      assert.deepEqual(clean, [], 'clean-to-clean edit timed out or reported errors');

      writeFileSync(file, t2);
      const broken = await srv.diagnosticsFor(file, 'typescript', t2);
      assert.ok(broken && broken.some((x) => x.severity === 'error'), 'new error not reported');

      writeFileSync(file, t1);
      assert.deepEqual(await srv.diagnosticsFor(file, 'typescript', t1), []);
    } finally {
      await srv.stop().catch(() => undefined);
    }
  });

  it('reports not-alive after stop so the manager can respawn it', { skip: !launch, timeout: 30_000 }, async () => {
    const r2 = lspRoot('she-lsp-alive-');
    const srv = new LspServer(spec!, r2, resolveServer(spec!, r2)!);
    await srv.start();
    assert.equal(srv.isAlive, true);
    await srv.stop();
    assert.equal(srv.isAlive, false);
  });
});
