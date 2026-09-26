import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWN_SERVERS, resolveServer } from '../lsp-client.js';
import { LspManager, executeLspTool, stripBom } from '../lsp-tools.js';

/*
 * Regression: LSP positions were off by one column on line 1 of a file starting with a UTF-8 BOM.
 *
 * The file text went to `didOpen` with U+FEFF still at index 0, so the server counted it as a
 * column while the model (via `fs_read`, which strips it) did not: `lsp_definition` at 1:15 on
 * `import type { Point } ...` returned nothing and 1:16 worked (seen in _she-live-test/src/main.ts).
 */
describe('lsp: UTF-8 BOM does not shift columns', () => {
  it('stripBom removes only a leading BOM', () => {
    assert.equal(stripBom('\uFEFFabc'), 'abc');
    assert.equal(stripBom('abc'), 'abc');
    assert.equal(stripBom('a\uFEFFb'), 'a\uFEFFb');
    assert.equal(stripBom('\uFEFF\uFEFFx'), '\uFEFFx');
    assert.equal(stripBom(''), '');
  });

  const spec = KNOWN_SERVERS.find((s) => s.id === 'typescript');
  const root = mkdtempSync(join(tmpdir(), 'she-lsp-bom-'));
  const launch = spec ? resolveServer(spec, root) : null;

  it('definition, hover and diagnostics use BOM-less columns', { skip: !launch, timeout: 60_000 }, async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src/**/*.ts'] }));
    // The target file has a BOM too: results mapped back must not be shifted either.
    writeFileSync(join(root, 'src', 'types.ts'), '\uFEFFexport interface Point { x: number; y: number }\n');
    // Line 1: `Point` at column 15, and an error at `k` (column 45). Line 2: an error at `bad` (column 7).
    const body = 'import type { Point } from "./types"; const k: string = 1;\nconst bad: number = "s";\n'
      + 'export function len(p: Point): number {\n  return p.x + p.y + bad + k.length;\n}\n';
    writeFileSync(join(root, 'src', 'main.ts'), '\uFEFF' + body);
    const manager = new LspManager(root);
    try {
      const def = await executeLspTool('lsp_definition', { path: 'src/main.ts', line: 1, column: 15 }, root, manager);
      assert.ok(def?.ok, def?.output);
      assert.match(def!.output, /types\.ts:1:18/, `definition at 1:15 should hit Point: ${def!.output}`);

      const hover = await executeLspTool('lsp_hover', { path: 'src/main.ts', line: 1, column: 15 }, root, manager);
      assert.match(String(hover?.output), /Point/, String(hover?.output));

      const diags = await executeLspTool('lsp_diagnostics', { path: 'src/main.ts' }, root, manager);
      assert.match(String(diags?.output), /main\.ts:1:45/, String(diags?.output));
      assert.match(String(diags?.output), /main\.ts:2:7/, String(diags?.output));

      // A definition landing ON line 1 of the opened BOM file must come back at the visible column.
      const self = await executeLspTool('lsp_definition', { path: 'src/main.ts', line: 4, column: 28 }, root, manager);
      assert.match(String(self?.output), /main\.ts:1:45/, String(self?.output));
    } finally {
      await manager.dispose().catch(() => undefined);
      try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
    }
  });
});
