/**
 * Shared scratchpad (memo) — editable by both the user and the agent.
 *
 * Small surface, but it is the one place both parties write concurrently, so
 * the ordering and persistence guarantees are what matter.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoStore } from '../memo-tools.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-memo-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('MemoStore', () => {
  it('adds an entry and reads it back', () => {
    const store = new MemoStore(dir);
    const e = store.add('记得改配置', 'user');
    assert.equal(e.text, '记得改配置');
    assert.equal(e.author, 'user');
    assert.equal(e.done, false);
    assert.equal(store.list().length, 1);
  });

  it('keeps insertion order (oldest first)', () => {
    const store = new MemoStore(dir);
    store.add('第一条');
    store.add('第二条');
    // Append order, not newest-first: the list is a log, and both the UI and
    // `memo_list` read it top-down. Pinned here so a change of order is a
    // deliberate decision rather than an accident.
    assert.deepEqual(store.list().map((e) => e.text), ['第一条', '第二条']);
  });

  it('distinguishes authors', () => {
    const store = new MemoStore(dir);
    store.add('用户写的', 'user');
    store.add('模型写的', 'agent');
    const byAuthor = Object.fromEntries(store.list().map((e) => [e.text, e.author]));
    assert.equal(byAuthor['用户写的'], 'user');
    assert.equal(byAuthor['模型写的'], 'agent');
  });

  it('toggling done persists', () => {
    const store = new MemoStore(dir);
    const e = store.add('待办');
    const updated = store.update(e.id, { done: true })!;
    assert.equal(updated.done, true);
    assert.equal(new MemoStore(dir).list()[0].done, true, '重载后应保持 done');
  });

  it('editing text persists', () => {
    const store = new MemoStore(dir);
    const e = store.add('旧文案');
    store.update(e.id, { text: '新文案' });
    assert.equal(new MemoStore(dir).list()[0].text, '新文案');
  });

  it('removing an entry reports whether anything was removed', () => {
    const store = new MemoStore(dir);
    const e = store.add('要删的');
    assert.equal(store.remove(e.id), true);
    assert.equal(store.list().length, 0);
    assert.equal(store.remove(e.id), false, '重复删除应返回 false');
  });

  it('updating a missing id returns undefined instead of throwing', () => {
    const store = new MemoStore(dir);
    assert.equal(store.update('memo_nonexistent', { done: true }), undefined);
  });

  it('a corrupt store file degrades to empty rather than crashing', () => {
    const store = new MemoStore(dir);
    store.add('先写一条'); // creates the file
    // Simulate a half-written file (e.g. process killed mid-save).
    writeFileSync(join(dir, '.she', 'memo.json'), '{ not json', 'utf8');
    assert.deepEqual(store.list(), [], '坏文件应降级为空列表而不是抛异常');
    // And the store must still be usable afterwards.
    store.add('仍然可用');
    assert.equal(store.list().length, 1);
  });

  it('tolerates a UTF-8 BOM in the store file', () => {
    const store = new MemoStore(dir);
    store.add('原始');
    const p = join(dir, '.she', 'memo.json');
    const body = readFileSync(p, 'utf8');
    // PowerShell's Set-Content writes a BOM; an earlier parser choked on it.
    writeFileSync(p, '\uFEFF' + body, 'utf8');
    assert.equal(store.list().length, 1, '带 BOM 的文件应能被解析');
  });

  it('rejects blank text at the tool and API boundary', async () => {
    /*
     * The store itself will persist a blank entry (it trims and saves), so the
     * guarantee lives at the boundaries — both the tool and POST /api/memo
     * refuse empty text. Asserting it here means a removed guard shows up as a
     * failure instead of an invisible row in the memo panel.
     */
    const { createMemoTools } = await import('../memo-tools.js');
    const tools = createMemoTools(dir);
    const out = await tools.execute('memo_add', { text: '   ' });
    assert.match(out, /required|error/i, `空文本应被工具拒绝，实际: ${out}`);
    const viaMissing = await tools.execute('memo_add', {});
    assert.match(viaMissing, /required|error/i, '缺参数也应被拒绝');
    assert.equal(new MemoStore(dir).list().length, 0, '被拒绝的内容不应落盘');
  });
});
