/**
 * Attachments: where a pasted file is stored and how it is read back.
 *
 * Two properties carry the weight here, and both are about the boundary rather than the happy path:
 *
 *   1. **Names are generated, not trusted.** The upload arrives with a filename the client chose
 *      and a body the client wrote. If the server ever wrote to a path derived from that name, a
 *      `<img onerror>` in a filename, or `../../../.env`, would be a write primitive. The tests
 *      pin the sanitising, not just the success case.
 *   2. **Reading back is confined to one directory.** The preview route takes a name from a query
 *      string, so `..` and an embedded separator both have to fail — checked on the RESOLVED path,
 *      since `a/../../b` is only visible after resolution.
 *
 * A third is quieter but decides whether an image survives a conversation: the stored path must be
 * the ABSOLUTE path, because the providers open it on every later request of that conversation, from
 * a process whose cwd may have moved. A relative path here would work in the test and fail in
 * production, so the shape is asserted directly.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ATTACHMENT_MAX_BYTES,
  attachmentExt,
  attachmentMime,
  attachmentsDir,
  resolveAttachmentFile,
  safeAttachmentLabel,
  saveAttachment,
} from '../attachments.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'she-attach-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const bytes = (n = 16) => Buffer.alloc(n, 7);

describe('附件：写入', () => {
  it('落在 .she/attachments 下，并且返回绝对路径', () => {
    const saved = saveAttachment(root, bytes(), 'shot.png', 'image/png');
    assert.equal(saved.path, join(attachmentsDir(root), saved.name));
    assert.ok(existsSync(saved.path), '文件应当真的写到磁盘上');
    assert.equal(readFileSync(saved.path).length, 16);
    // 绝对路径是必须的：providers 在每个后续回合都要按这个路径读盘。
    assert.ok(saved.path.startsWith(root), `期望绝对路径，得到 ${saved.path}`);
    assert.equal(saved.relPath, join('.she', 'attachments', saved.name));
  });

  it('两次粘贴同名文件不会互相覆盖', () => {
    const a = saveAttachment(root, bytes(), 'image.png', 'image/png');
    const b = saveAttachment(root, bytes(32), 'image.png', 'image/png');
    assert.notEqual(a.name, b.name);
    assert.ok(existsSync(a.path) && existsSync(b.path));
    assert.equal(readFileSync(b.path).length, 32, '第二个文件必须还是自己的内容');
  });

  it('原名只能作为可读后缀，不能决定路径', () => {
    const evil = saveAttachment(root, bytes(), '../../../../etc/passwd.png', 'image/png');
    assert.equal(evil.path, join(attachmentsDir(root), evil.name));
    assert.ok(!evil.name.includes('/') && !evil.name.includes('\\') && !evil.name.includes('..'));
    // 目录分隔符被剥掉，但尾部还剩可读的部分，便于人一眼认出。
    assert.ok(evil.name.endsWith('passwd.png'));
  });

  it('空文件被拒（否则会写出一个 0 字节的「图片」让模型反复读失败）', () => {
    assert.throws(() => saveAttachment(root, Buffer.alloc(0), 'a.png', 'image/png'), /空/);
  });

  it('超过上限被拒，并且不留下半个文件', () => {
    const before = existsSync(attachmentsDir(root));
    assert.throws(
      () => saveAttachment(root, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1), 'big.png', 'image/png'),
      /过大/,
    );
    if (!before) assert.ok(!existsSync(attachmentsDir(root)), '被拒的上传不应创建目录');
  });

  it('MIME 缺失时按扩展名补，且只认白名单里的图', () => {
    const saved = saveAttachment(root, bytes(), 'shot.webp', 'application/octet-stream');
    assert.equal(saved.mime, 'image/webp');
    assert.ok(saved.name.endsWith('.webp'));
  });
});

describe('附件：扩展名与 MIME', () => {
  it('后缀白名单之外的按 MIME 归一', () => {
    assert.equal(attachmentExt('a.jpeg', 'image/jpeg'), '.jpg');
    assert.equal(attachmentExt('a.HEIC', 'image/png'), '.png');
    assert.equal(attachmentExt('noext', 'image/webp'), '.webp');
    assert.equal(attachmentExt('noext', 'text/plain'), '.bin');
  });

  it('pdf / json / 文本各自有正确的 MIME', () => {
    assert.equal(attachmentMime('x.pdf'), 'application/pdf');
    assert.equal(attachmentMime('x.json'), 'application/json');
    assert.match(attachmentMime('x.md'), /^text\/plain/);
    assert.equal(attachmentMime('x.png'), 'image/png');
    assert.equal(attachmentMime('x.unknownext'), 'application/octet-stream');
  });

  it('全是不安全字符时仍有可读兜底名', () => {
    assert.equal(safeAttachmentLabel('///'), 'attachment');
    assert.ok(safeAttachmentLabel('   ').length > 0);
  });
});

describe('附件：回读只允许在附件目录内', () => {
  it('正常名字可以解析到文件', () => {
    const saved = saveAttachment(root, bytes(), 'shot.png', 'image/png');
    assert.equal(resolveAttachmentFile(root, saved.name), saved.path);
  });

  it('目录穿越被拒（按解析后的路径判断，字符串上看不出来）', () => {
    mkdirSync(join(root, '.she'), { recursive: true });
    writeFileSync(join(root, 'secret.txt'), 'nope');
    for (const bad of ['../secret.txt', '..\\secret.txt', '.she/attachments/../../secret.txt', 'nested/shot.png']) {
      assert.throws(() => resolveAttachmentFile(root, bad), /不合法/, `应当拒绝 ${bad}`);
    }
  });

  it('隐藏文件与空名字被拒', () => {
    assert.throws(() => resolveAttachmentFile(root, '.env'), /不合法/);
    assert.throws(() => resolveAttachmentFile(root, ''), /不合法/);
    assert.throws(() => resolveAttachmentFile(root, '   '), /不合法/);
  });
});
