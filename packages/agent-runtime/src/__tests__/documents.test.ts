/**
 * Document attachments: what the model is actually told about a non-image file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The behaviour being pinned is "a document that uploads successfully must reach the model
 * as something it can use, or must say plainly that it cannot".
 *
 * Before this, every non-image fell through `resolveImages`, which reported it as
 * `（附件 … 的类型 application/pdf 不支持，已跳过）`. The upload succeeded, the chip appeared,
 * and the request contained a line saying the file would never be seen — so a question about
 * an attached PDF came back as though nothing had been attached.
 *
 * The three outcomes here are deliberately different from each other, and the test asserts
 * which one each input gets rather than only that "something" was produced:
 *
 *   text-shaped  → the content is inlined
 *   binary       → the PATH is inlined, with an instruction to go read it
 *   unreadable   → a reason is inlined
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTextAttachment, resolveAttachments, MAX_DOCUMENT_BYTES } from '../providers/documents.js';

const fakeFs = (files: Record<string, Buffer>) => ({
  readFile: (p: string) => {
    const b = files[p];
    if (!b) throw new Error('ENOENT');
    return b;
  },
  sizeOf: (p: string) => {
    const b = files[p];
    if (!b) throw new Error('ENOENT');
    return b.length;
  },
});

describe('附件分类：文本 / 二进制 / 读不到', () => {
  it('文本类按扩展名内联，内容包括文件名与正文', () => {
    const files = { '/ws/.she/attachments/abc-12345678-notes.md': Buffer.from('# 标题\n\n正文内容') };
    const { images, documentText } = resolveAttachments(
      [{ path: '/ws/.she/attachments/abc-12345678-notes.md', mime: 'text/plain' }],
      fakeFs(files),
    );
    assert.equal(images.length, 0);
    assert.match(documentText, /【附件 notes\.md】/);
    assert.match(documentText, /正文内容/);
    // 生成的随机前缀不该出现在给模型看的名字里。
    assert.ok(!documentText.includes('12345678'), '存储前缀泄漏到了附件名');
  });

  it('二进制只给路径，不伪造内容', () => {
    const path = '/ws/.she/attachments/abc-12345678-报告.pdf';
    const { documentText } = resolveAttachments(
      [{ path, mime: 'application/pdf' }],
      fakeFs({ [path]: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]) }),
    );
    assert.match(documentText, /【附件 报告\.pdf】/);
    // 关键：说的是"文件在哪"，不是"内容如下"。说成后者会让模型凭空白话。
    assert.match(documentText, /已存放在你的工作区里/);
    assert.match(documentText, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.ok(!documentText.includes('```'), '二进制文件被当成文本贴了出来');
  });

  it('读不到的文件说明原因，而不是安静丢掉', () => {
    const { documentText, skipped } = resolveAttachments(
      [{ path: '/ws/.she/attachments/gone-12345678-x.csv', mime: 'text/csv' }],
      fakeFs({}),
    );
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /读不到/);
    /*
     * 原因要跟着请求一起送给模型，而不是只留在返回值里。
     * 留在返回值里等于没人看见：上传成功、chip 出现、模型收到一条什么都没说的消息。
     */
    assert.match(documentText, /读不到/);
    /*
     * 措辞必须按种类分开：一个读不到的 `.csv` 不能说成"图片未能发送"，
     * 那会让模型去找一张根本不存在的图片。
     */
    assert.match(documentText, /文档未能随本消息发送/);
    assert.ok(!documentText.includes('图片未能'), `把文档说成了图片: ${documentText}`);
  });

  it('超长文本截断并说明，完整路径仍给出', () => {
    const path = '/ws/.she/attachments/abc-12345678-big.txt';
    const big = Buffer.alloc(MAX_DOCUMENT_BYTES + 4096, 0x61);
    const { documentText } = resolveAttachments([{ path, mime: 'text/plain' }], fakeFs({ [path]: big }));
    assert.match(documentText, /只附上开头/);
    assert.match(documentText, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('图片仍然走图片那条路，不会被这一段改变', () => {
    const path = '/ws/.she/attachments/abc-12345678-shot.png';
    const { images, documentText } = resolveAttachments(
      [{ path, mime: 'image/png' }],
      fakeFs({ [path]: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }),
    );
    assert.equal(images.length, 1);
    assert.equal(images[0].mime, 'image/png');
    assert.equal(documentText, '', '图片不该被再当成文档说一遍');
  });

  it('图片与文档同时存在时各走各的', () => {
    const img = '/ws/.she/attachments/a-12345678-p.png';
    const doc = '/ws/.she/attachments/b-12345678-n.md';
    const { images, documentText } = resolveAttachments(
      [{ path: img, mime: 'image/png' }, { path: doc, mime: 'text/markdown' }],
      fakeFs({ [img]: Buffer.from([0x89, 0x50, 0x4e, 0x47]), [doc]: Buffer.from('hello') }),
    );
    assert.equal(images.length, 1);
    assert.match(documentText, /hello/);
    assert.ok(!documentText.includes('a-12345678-p.png'), '图片被重复当成文档报告了');
  });
});

describe('文本还是二进制：谁说了算', () => {
  it('扩展名认识且没声明类型 → 文本', () => {
    assert.equal(isTextAttachment('/x/notes.md', ''), true);
    assert.equal(isTextAttachment('/x/main.py', 'application/octet-stream'), true);
  });

  it('明确声明了非文本类型 → 以声明为准，即使扩展名像文本', () => {
    // 矛盾时按保守那侧走：内联一个其实不是文本的文件，会把乱码塞进上下文并掩盖真问题。
    assert.equal(isTextAttachment('/x/notes.md', 'application/pdf'), false);
    assert.equal(isTextAttachment('/x/data.json', 'application/zip'), false);
  });

  it('不认识扩展名但声明是文本 → 文本', () => {
    assert.equal(isTextAttachment('/x/thing.weird', 'text/plain'), true);
  });

  it('两者都说不认识 → 二进制', () => {
    assert.equal(isTextAttachment('/x/blob.weird', ''), false);
    assert.equal(isTextAttachment('/x/blob.weird', 'application/octet-stream'), false);
  });
});
