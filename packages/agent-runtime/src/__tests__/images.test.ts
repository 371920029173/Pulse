/**
 * Attached images reach the endpoint as content parts, and a *failed* attachment reaches it as a
 * sentence instead of silence.
 *
 * The failure half is the reason these tests exist. An attachment is a convenience the user
 * reached for; when the file is gone or too large, the request must still go out (a stale path
 * may not fail the turn) and the model must be told, because a model that answers "I don't see any
 * image" is useful and a model that confidently describes a screenshot it never received is not.
 *
 * `resolveImages` takes injectable reader/size functions precisely so this can be tested without
 * writing 6 MB of PNG to disk or depending on a real file layout.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  IMAGE_MIME_ALLOWLIST,
  MAX_IMAGE_BYTES,
  formatMb,
  guessImageMime,
  normalizeImageMime,
  resolveImageMime,
  resolveImages,
  skippedNotice,
} from '../providers/images.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import type { LLMMessage } from '@she/shared';

const dir = mkdtempSync(join(tmpdir(), 'she-images-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A 1×1 PNG — the smallest real image, so the base64 path is exercised with actual bytes. */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function writeImage(name: string, bytes: Buffer = PNG_1PX): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

describe('resolveImages', () => {
  it('reads a real file into both wire shapes', () => {
    const path = writeImage('ok.png');
    const { ok, skipped } = resolveImages([{ path, mime: 'image/png' }]);
    assert.equal(skipped.length, 0);
    assert.equal(ok.length, 1);
    assert.equal(ok[0].mime, 'image/png');
    assert.equal(ok[0].base64, PNG_1PX.toString('base64'));
    assert.equal(ok[0].dataUrl, `data:image/png;base64,${PNG_1PX.toString('base64')}`);
    assert.equal(ok[0].bytes, PNG_1PX.length);
  });

  it('keeps the order the user attached them in', () => {
    const a = writeImage('a.png');
    const b = writeImage('b.png', Buffer.concat([PNG_1PX, Buffer.from('padding')]));
    const { ok } = resolveImages([
      { path: a, mime: 'image/png' },
      { path: b, mime: 'image/png' },
    ]);
    assert.deepEqual(ok.map((i) => i.path), [a, b]);
  });

  it('explains a missing file instead of throwing — a stale path must not fail the turn', () => {
    const { ok, skipped } = resolveImages([{ path: join(dir, 'nope.png'), mime: 'image/png' }]);
    assert.equal(ok.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /读不到/);
  });

  it('refuses an oversized file before reading it into memory', () => {
    let read = 0;
    const { ok, skipped } = resolveImages(
      [{ path: join(dir, 'huge.png'), mime: 'image/png' }],
      {
        readFile: () => { read++; return PNG_1PX; },
        sizeOf: () => MAX_IMAGE_BYTES + 1,
      },
    );
    assert.equal(ok.length, 0);
    assert.equal(read, 0, '超限的文件不该被读进内存');
    assert.match(skipped[0], /超过上限/);
  });

  it('refuses a type the endpoint would reject, rather than letting it 400 the turn', () => {
    const path = writeImage('doc.tiff');
    const { ok, skipped } = resolveImages([{ path, mime: 'image/tiff' }]);
    assert.equal(ok.length, 0);
    assert.match(skipped[0], /不支持/);
  });

  it('treats an empty file as a failure, not as a zero-byte image', () => {
    const path = writeImage('empty.png', Buffer.alloc(0));
    const { ok, skipped } = resolveImages([{ path, mime: 'image/png' }]);
    assert.equal(ok.length, 0);
    assert.match(skipped[0], /空文件/);
  });

  it('falls back to the extension when the client sends no MIME', () => {
    const path = writeImage('shot.jpg');
    const { ok } = resolveImages([{ path, mime: '' }]);
    assert.equal(ok[0].mime, 'image/jpeg', 'image/jpg/jpeg 与扩展名都要能认');
  });

  it('falls back to the extension for an unknown MIME, and still refuses an unknown extension', () => {
    const a = writeImage('picture.webp');
    assert.equal(resolveImages([{ path: a, mime: 'application/octet-stream' }]).ok.length, 1);
    const b = writeImage('plain.xyz');
    assert.equal(resolveImages([{ path: b, mime: '' }]).ok.length, 0);
  });

  it('normalises the MIME forms seen in the wild', () => {
    assert.equal(normalizeImageMime('IMAGE/PNG'), 'image/png');
    assert.equal(normalizeImageMime('image/jpg'), 'image/jpeg');
    assert.equal(normalizeImageMime('image/png;charset=binary'), 'image/png');
    assert.equal(guessImageMime('A.PNG'), 'image/png');
    assert.equal(guessImageMime('x.jpeg'), 'image/jpeg');
    assert.equal(guessImageMime('x.txt'), '');
    assert.deepEqual([...IMAGE_MIME_ALLOWLIST], ['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    assert.equal(formatMb(6 * 1024 * 1024), '6.0MB');
  });

  it('says nothing when there is nothing to say', () => {
    assert.equal(skippedNotice([]), '');
    assert.match(skippedNotice(['（附件 x 读不到）']), /图片未能随本消息发送/);
  });
});

// ─── The two wire shapes ────────────────────────────────────────────────────

/** Capture the request body each provider would send, without any network. */
function capturingFetch(seen: Array<Record<string, unknown>>) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        content: [{ type: 'text', text: 'ok' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

describe('resolveImageMime', () => {
  /*
   * The single rule both halves of the feature depend on: the upload stores a type and the
   * provider sends a type, and if those two ever disagree the image is stored as something
   * nothing will read back as an image. Tested here rather than through either caller so a
   * divergence shows up as one failing rule instead of two mysterious symptoms.
   */
  it('a declared type we accept wins', () => {
    assert.equal(resolveImageMime('image/png', 'noext'), 'image/png');
    assert.equal(resolveImageMime('image/jpg', 'x.png'), 'image/jpeg');
    assert.equal(resolveImageMime('image/webp; charset=binary', 'x.png'), 'image/webp');
  });

  it('an unusable declared type falls back to the extension', () => {
    assert.equal(resolveImageMime('application/octet-stream', 'x.webp'), 'image/webp');
    assert.equal(resolveImageMime('', 'x.jpeg'), 'image/jpeg');
    assert.equal(resolveImageMime('text/plain', 'shot.PNG'), 'image/png');
  });

  it('neither knows: empty, so the caller can report a reason instead of sending junk', () => {
    assert.equal(resolveImageMime('', 'notes.txt'), '');
    assert.equal(resolveImageMime('application/pdf', 'doc.pdf'), '');
  });
});

describe('images on the wire', () => {
  it('OpenAI gets an image_url data URL, and text-only turns keep the plain string shape', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = capturingFetch(seen);
    try {
      const provider = new OpenAIProvider('k', 'http://x', 'm', 0, 0);
      const path = writeImage('wire.png');
      await provider.chat([
        { role: 'user', content: '看图' , images: [{ path, mime: 'image/png' }] },
        { role: 'user', content: '这一条没有图' },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }

    const messages = seen[0].messages as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(messages[0].content), '带图的那条要是 content parts');
    assert.deepEqual(
      (messages[0].content as Array<Record<string, unknown>>).map((p) => p.type),
      ['text', 'image_url'],
    );
    assert.match(
      String((messages[0].content as Array<{ image_url?: { url?: string } }>)[1].image_url?.url),
      /^data:image\/png;base64,/,
    );
    // The cache property: a text-only turn is still a bare string.
    assert.equal(typeof messages[1].content, 'string', '没有图的回合必须保持字符串，不能改形');
  });

  it('OpenAI is told when an image could not be sent, instead of being handed a silent gap', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = capturingFetch(seen);
    try {
      const provider = new OpenAIProvider('k', 'http://x', 'm', 0, 0);
      await provider.chat([
        { role: 'user', content: '看这张', images: [{ path: join(dir, 'gone.png'), mime: 'image/png' }] },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
    const messages = seen[0].messages as Array<Record<string, unknown>>;
    assert.equal(typeof messages[0].content, 'string', '一张都没成功时不要改形成 parts');
    assert.match(String(messages[0].content), /图片未能随本消息发送/);
    assert.match(String(messages[0].content), /看这张/, '用户原本的话必须还在');
  });

  it('Anthropic gets a base64 source block, not a data URL', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = capturingFetch(seen);
    try {
      const provider = new AnthropicProvider('k', 'm', 0, 0);
      const path = writeImage('wire2.png');
      await provider.chat([{ role: 'user', content: '看图', images: [{ path, mime: 'image/png' }] }]);
    } finally {
      globalThis.fetch = realFetch;
    }

    const messages = seen[0].messages as Array<Record<string, unknown>>;
    const blocks = messages[0].content as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(blocks));
    assert.equal(blocks[0].type, 'image', '图片在前，文字当作它的说明');
    const source = blocks[0].source as Record<string, string>;
    assert.equal(source.type, 'base64');
    assert.equal(source.media_type, 'image/png');
    assert.equal(source.data, PNG_1PX.toString('base64'), 'Anthropic 不吃 data: 前缀');
    assert.equal(blocks[1].type, 'text');
    assert.equal(blocks[1].text, '看图');
  });

  it('Anthropic gets the failure as text too', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = capturingFetch(seen);
    try {
      const provider = new AnthropicProvider('k', 'm', 0, 0);
      await provider.chat([
        { role: 'user', content: '看这张', images: [{ path: join(dir, 'gone2.png'), mime: 'image/png' }] },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
    const messages = seen[0].messages as Array<Record<string, unknown>>;
    assert.equal(typeof messages[0].content, 'string');
    assert.match(String(messages[0].content), /图片未能随本消息发送/);
  });

  it('an assistant turn never carries images, and tool turns stay strings', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = capturingFetch(seen);
    try {
      const provider = new OpenAIProvider('k', 'http://x', 'm', 0, 0);
      const path = writeImage('never.png');
      const messages: LLMMessage[] = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', images: [{ path, mime: 'image/png' }] },
      ];
      await provider.chat(messages);
    } finally {
      globalThis.fetch = realFetch;
    }
    const sent = seen[0].messages as Array<Record<string, unknown>>;
    assert.equal(typeof sent[1].content, 'string', '助手回合不该被加上图片分片');
  });
});
