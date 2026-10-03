import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspServer, type ServerSpec } from '../lsp-client.js';

/*
 * The fallback in `diagnosticsFor` closes and reopens a document to force a publish when an
 * edit produces none. The close has a side effect that is shaped exactly like a real answer:
 * servers clear the diagnostics of the document they just dropped, i.e. they publish an EMPTY
 * set. If that clear is not consumed before the reopen, it can win the race and report a file
 * with errors as clean.
 *
 * This is the one thing a stub can pin deterministically and a real server cannot: against
 * typescript-language-server the race needs a loaded machine (that is how it was caught — the
 * `lsp: diagnostics after a clean-to-clean edit` suite failed inside the full gate, and passed
 * on its own). Here the stub simply never answers a `didChange`, so the fallback always runs.
 */

/** A language server that answers on open, clears on close, and stays silent on change. */
const STUB_SOURCE = `
import fs from 'node:fs';

const journal = process.env.STUB_JOURNAL;
const note = (entry) => { if (journal) fs.appendFileSync(journal, JSON.stringify(entry) + '\\n'); };

let buf = Buffer.alloc(0);
let openUri = null;

function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
}

function publish(uri, text) {
  const broken = text.includes('BROKEN');
  note({ publish: broken ? 'error' : 'empty' });
  const diagnostics = broken
    ? [{
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 1,
      source: 'stub',
      message: 'stub: 这一行是坏的',
    }]
    : [];
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}

function handle(msg) {
  if (msg.id !== undefined && msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocument: { publishDiagnostics: {} } } } });
    return;
  }
  if (msg.id !== undefined && msg.method === 'textDocument/hover') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  if (msg.method === 'textDocument/didOpen') {
    openUri = msg.params.textDocument.uri;
    note({ recv: 'didOpen' });
    publish(openUri, msg.params.textDocument.text);
    return;
  }
  if (msg.method === 'textDocument/didChange') {
    // Deliberately silent: this is the case the close/reopen fallback exists for.
    note({ recv: 'didChange' });
    return;
  }
  if (msg.method === 'textDocument/didClose') {
    note({ recv: 'didClose' });
    publish(openUri, '');
    return;
  }
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\\r\\n\\r\\n');
    if (sep < 0) return;
    const len = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, sep).toString())[1]);
    if (buf.length < sep + 4 + len) return;
    const body = buf.subarray(sep + 4, sep + 4 + len).toString();
    buf = buf.subarray(sep + 4 + len);
    handle(JSON.parse(body));
  }
});
`;

const roots: string[] = [];
after(async () => {
  for (const root of roots) {
    for (let attempt = 0; attempt < 12; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break; } catch { await new Promise((r) => { setTimeout(r, 250); }); }
    }
  }
});

describe('lsp: 关文档时的清空不能当成答案', () => {
  it('重开文档后报的是新文本的诊断，不是 didClose 的清空', { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'she-lsp-clear-'));
    roots.push(root);
    const journal = join(root, 'journal.jsonl');
    const stub = join(root, 'stub-lsp.mjs');
    writeFileSync(stub, STUB_SOURCE);
    const file = join(root, 'mod.ts');
    writeFileSync(file, 'clean\n');

    const spec: ServerSpec = { id: 'stub', languages: ['typescript'], command: 'stub', args: [] };
    const srv = new LspServer(spec, root, { command: process.execPath, args: [stub], via: 'stub' });
    process.env.STUB_JOURNAL = journal;
    try {
      await srv.start();
      // Opens the document; the stub's open-time publish answers this, so the clean text is
      // already cached and the edit below is the only thing left to answer.
      await srv.hover(file, 'typescript', 'clean\n', { line: 0, character: 0 });

      const diagnostics = await srv.diagnosticsFor(file, 'typescript', 'BROKEN\n');
      assert.ok(
        diagnostics && diagnostics.some((d) => d.severity === 'error'),
        `BROKEN 文本必须报错，实际拿到 ${JSON.stringify(diagnostics)}（空数组 = 把 didClose 的清空当成了答案）`,
      );

      // And the shape of the conversation, so a future change that reorders close/reopen
      // fails here instead of only on a loaded machine.
      const seen = readFileSync(journal, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line))
        .map((entry) => entry.recv ?? `publish:${entry.publish}`);
      assert.deepEqual(seen, [
        'didOpen', 'publish:empty',        // 打开干净文件
        'didChange',                       // 改成 BROKEN，服务器不回应
        'didClose', 'publish:empty',       // 清空必须先被吃掉
        'didOpen', 'publish:error',        // 重开拿到的才是答案
      ]);
    } finally {
      delete process.env.STUB_JOURNAL;
      await srv.stop().catch(() => undefined);
    }
  });
});
