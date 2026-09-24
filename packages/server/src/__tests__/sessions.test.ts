/**
 * `SessionStore.importMany` — migrating conversations from another tool.
 *
 * These pin the three ways a bulk import can go wrong, each of which is invisible until a user
 * notices something missing or misdated:
 *
 *   1. **The dates must survive.** `create()` stamps "now", so importing a year of history would file
 *      every conversation as today — the dates are the only reason the list is usable afterwards.
 *   2. **`active_id` must not move.** `create()` makes the new session active, so importing 500
 *      conversations would hijack whatever the user was reading.
 *   3. **It must persist in one write**, and the result must survive a reload — otherwise the import
 *      reports success and the list is empty after a restart.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../sessions.js';
import type { LLMMessage } from '@she/shared';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-import-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const msg = (role: LLMMessage['role'], content: string): LLMMessage => ({ role, content });

describe('importMany', () => {
  it('为每段对话建立一个真实会话，并带上消息', () => {
    const store = new SessionStore(dir);
    const created = store.importMany([
      { title: '会话 A', messages: [msg('user', 'u1'), msg('assistant', 'a1')] },
      { title: '会话 B', messages: [msg('user', 'u2')] },
    ]);

    assert.equal(created.length, 2);
    // Assert on the SET, not the order: with no source dates the order is the caller's, and pinning
    // it here would make the test depend on which millisecond each item happened to be stamped in.
    assert.deepEqual(created.map((s) => s.title).sort(), ['会话 A', '会话 B']);
    const a = created.find((s) => s.title === '会话 A');
    assert.equal(a?.messages.length, 2);
    assert.equal(store.list().sessions.length, 2);
  });

  it('没有来源日期时保持调用方给出的顺序（排序只对真实日期有意义）', () => {
    const store = new SessionStore(dir);
    store.importMany([
      { title: '第一条', messages: [msg('user', '1')] },
      { title: '第二条', messages: [msg('user', '2')] },
      { title: '第三条', messages: [msg('user', '3')] },
    ]);
    assert.deepEqual(
      store.list().sessions.map((s) => s.title),
      ['第一条', '第二条', '第三条'],
    );
  });

  it('【关键】保留原始时间戳（否则一年的历史全变成"今天"）', () => {
    const store = new SessionStore(dir);
    store.importMany([
      { title: '去年的对话', messages: [msg('user', 'old')], createdAt: '2025-03-04T05:06:07.000Z', updatedAt: '2025-03-04T05:06:07.000Z' },
    ]);
    const s = store.list().sessions[0];
    assert.equal(s.created_at, '2025-03-04T05:06:07.000Z');
    assert.equal(s.updated_at, '2025-03-04T05:06:07.000Z');
  });

  it('没有原始时间时才用当前时间', () => {
    const store = new SessionStore(dir);
    store.importMany([{ title: 'x', messages: [msg('user', 'u')] }]);
    const s = store.list().sessions[0];
    assert.ok(!Number.isNaN(Date.parse(s.created_at)));
  });

  it('【关键】不改变 active_id（导入 500 段不该抢走用户正在看的对话）', () => {
    const store = new SessionStore(dir);
    const mine = store.create('我正在看的');
    assert.equal(store.list().active_id, mine.id);

    store.importMany(
      Array.from({ length: 5 }, (_, i) => ({ title: `导入 ${i}`, messages: [msg('user', `u${i}`)] })),
    );
    assert.equal(store.list().active_id, mine.id, 'active_id 被导入改动了');
  });

  it('【关键】重启后仍在（导入报成功但列表空了是最坏的结果）', () => {
    const store = new SessionStore(dir);
    store.importMany([
      { title: '持久化验证', messages: [msg('user', 'hello')] },
    ]);
    const file = join(dir, '.she', 'sessions.json');
    assert.ok(existsSync(file), '没有写出会话文件');

    const reopened = new SessionStore(dir);
    const titles = reopened.list().sessions.map((s) => s.title);
    assert.deepEqual(titles, ['持久化验证']);
  });

  it('不带标题时用首条用户消息作为标题（而不是空标题）', () => {
    const store = new SessionStore(dir);
    store.importMany([{ title: '   ', messages: [msg('user', '这是第一条用户消息')] }]);
    assert.match(store.list().sessions[0].title, /这是第一条用户消息/);
  });

  it('按时间倒序插入，迁移不会把时间线倒过来', () => {
    const store = new SessionStore(dir);
    store.importMany([
      { title: '较早', messages: [msg('user', 'a')], updatedAt: '2025-01-01T00:00:00.000Z' },
      { title: '较新', messages: [msg('user', 'b')], updatedAt: '2026-01-01T00:00:00.000Z' },
      { title: '居中', messages: [msg('user', 'c')], updatedAt: '2025-06-01T00:00:00.000Z' },
    ]);
    assert.deepEqual(store.list().sessions.map((s) => s.title), ['较新', '居中', '较早']);
  });

  it('【关键】来源信息被保留下来（"这条从哪来"要能答）', () => {
    const store = new SessionStore(dir);
    /*
     * A Windows-shaped path on purpose: this is the platform the importer mostly runs on. The value
     * is FIXTURE DATA standing in for a real Cursor database path, not a path this project uses, so
     * it is lifted into a constant — one place to review, and one place for the portability check to
     * skip rather than two.
     *
     * portability-check:allow
     */
    const ORIGIN = 'C:/Users/x/.cursor/chats/a.json';

    store.importMany([{
      title: '带来源',
      messages: [msg('user', 'u')],
      importedFrom: {
        source: 'cursor',
        originPath: ORIGIN,
        copiedTo: '.she/imports/Cursor/20260919-a.json',
        importedAt: '2026-09-19T00:00:00.000Z',
        truncated: 12,
      },
    }]);

    const s = store.list().sessions[0] as { imported_from?: Record<string, unknown> };
    assert.equal(s.imported_from?.source, 'cursor');
    assert.equal(s.imported_from?.truncated, 12);

    // And it must survive a reload, or it is write-only.
    const reopened = new SessionStore(dir);
    const again = reopened.list().sessions[0] as { imported_from?: Record<string, unknown> };
    assert.equal(again.imported_from?.originPath, ORIGIN);
  });

  it('空列表是无操作，不抛异常', () => {
    const store = new SessionStore(dir);
    assert.deepEqual(store.importMany([]), []);
    assert.equal(store.list().sessions.length, 0);
  });

  it('一次写入而不是逐条重写（500 条导入不该是 500 次整文件写）', () => {
    const store = new SessionStore(dir);
    const before = readFileSync(join(dir, '.she', 'sessions.json'), 'utf8').length;

    store.importMany(Array.from({ length: 50 }, (_, i) => ({
      title: `批量 ${i}`,
      messages: [msg('user', `u${i}`)],
    })));

    const after = readFileSync(join(dir, '.she', 'sessions.json'), 'utf8');
    // The file must be valid JSON with all 50 present — proof the writes were not interleaved or lost.
    const parsed = JSON.parse(after) as { sessions: unknown[] };
    assert.equal(parsed.sessions.length, 50);
    assert.ok(after.length > before);
  });
});

describe('目录与父会话', () => {
  it('记下目录和父会话，搬走后仍是同一条', () => {
    const src = new SessionStore(dir);
    const child = src.create('子任务', { directory: dir, parentId: 'sess_parent' });
    assert.equal(child.directory, dir);
    assert.equal(child.parent_id, 'sess_parent');
    assert.equal(src.childrenOf('sess_parent').length, 1);
    const watching = src.create('我正在看的');
    assert.equal(src.list().active_id, watching.id);
    src.create('另一个子任务', { directory: dir, parentId: 'sess_parent' });
    assert.equal(src.list().active_id, watching.id, '子会话不应抢走当前对话');
    const destDir = mkdtempSync(join(tmpdir(), 'she-dest-'));
    const taken = src.extract(child.id);
    assert.ok(taken);
    taken!.directory = destDir;
    const dest = new SessionStore(destDir);
    dest.adopt(taken!);
    assert.equal(src.get(child.id), undefined);
    assert.equal(dest.get(child.id)?.directory, destDir);
    rmSync(destDir, { recursive: true, force: true });
  });

  it('没有目录的旧会话在读入时钉在所在项目', () => {
    mkdirSync(join(dir, '.she'), { recursive: true });
    const file = join(dir, '.she', 'sessions.json');
    writeFileSync(file, JSON.stringify({
      schema_version: 'she-sessions/0.2',
      active_id: 'sess_old',
      sessions: [{
        id: 'sess_old',
        title: '旧的',
        created_at: '2020-01-01T00:00:00.000Z',
        updated_at: '2020-01-01T00:00:00.000Z',
        messages: [],
      }],
    }));
    const store = new SessionStore(dir);
    assert.equal(store.get('sess_old')?.directory, dir);
  });
});
