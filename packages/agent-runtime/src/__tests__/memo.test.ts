/**
 * 会话私有的草稿板（memo）—— 用户和这个会话的 agent 都能改。
 *
 * 小接口，但它是"双方并发写"的唯一一处，所以顺序与持久化保证才是重点。
 *
 * 2026-09-27 起它按会话分文件（`.she/sessions/<id>/memo.json`）。这一点在本文件里被钉成性质：
 * 两个会话 id 写入的东西互不可见 —— 不是"读的时候过滤掉"，是**两个文件**。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoStore } from '../memo-tools.js';

/** 本文件默认的会话；需要第二个会话时用 `OTHER`。 */
const SESS = 'sess_memo';
const OTHER = 'sess_other';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-memo-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('MemoStore', () => {
  it('adds an entry and reads it back', () => {
    const store = new MemoStore(dir, SESS);
    const e = store.add('记得改配置', 'user');
    assert.equal(e.text, '记得改配置');
    assert.equal(e.author, 'user');
    assert.equal(e.done, false);
    assert.equal(store.list().length, 1);
  });

  it('keeps insertion order (oldest first)', () => {
    const store = new MemoStore(dir, SESS);
    store.add('第一条');
    store.add('第二条');
    // Append order, not newest-first: the list is a log, and both the UI and
    // `memo_list` read it top-down. Pinned here so a change of order is a
    // deliberate decision rather than an accident.
    assert.deepEqual(store.list().map((e) => e.text), ['第一条', '第二条']);
  });

  it('distinguishes authors', () => {
    const store = new MemoStore(dir, SESS);
    store.add('用户写的', 'user');
    store.add('模型写的', 'agent');
    const byAuthor = Object.fromEntries(store.list().map((e) => [e.text, e.author]));
    assert.equal(byAuthor['用户写的'], 'user');
    assert.equal(byAuthor['模型写的'], 'agent');
  });

  it('toggling done persists', () => {
    const store = new MemoStore(dir, SESS);
    const e = store.add('待办');
    const updated = store.update(e.id, { done: true })!;
    assert.equal(updated.done, true);
    assert.equal(new MemoStore(dir, SESS).list()[0].done, true, '重载后应保持 done');
  });

  it('editing text persists', () => {
    const store = new MemoStore(dir, SESS);
    const e = store.add('旧文案');
    store.update(e.id, { text: '新文案' });
    assert.equal(new MemoStore(dir, SESS).list()[0].text, '新文案');
  });

  it('removing an entry reports whether anything was removed', () => {
    const store = new MemoStore(dir, SESS);
    const e = store.add('要删的');
    assert.equal(store.remove(e.id), true);
    assert.equal(store.list().length, 0);
    assert.equal(store.remove(e.id), false, '重复删除应返回 false');
  });

  it('updating a missing id returns undefined instead of throwing', () => {
    const store = new MemoStore(dir, SESS);
    assert.equal(store.update('memo_nonexistent', { done: true }), undefined);
  });

  it('a corrupt store file degrades to empty rather than crashing', () => {
    const store = new MemoStore(dir, SESS);
    store.add('先写一条'); // creates the file
    // Simulate a half-written file (e.g. process killed mid-save).
    writeFileSync(join(dir, '.she', 'sessions', SESS, 'memo.json'), '{ not json', 'utf8');
    assert.deepEqual(store.list(), [], '坏文件应降级为空列表而不是抛异常');
    // And the store must still be usable afterwards.
    store.add('仍然可用');
    assert.equal(store.list().length, 1);
  });

  it('tolerates a UTF-8 BOM in the store file', () => {
    const store = new MemoStore(dir, SESS);
    store.add('原始');
    const p = join(dir, '.she', 'sessions', SESS, 'memo.json');
    const body = readFileSync(p, 'utf8');
    // PowerShell's Set-Content writes a BOM; an earlier parser choked on it.
    writeFileSync(p, '\uFEFF' + body, 'utf8');
    assert.equal(store.list().length, 1, '带 BOM 的文件应能被解析');
  });

  it('【关键】两个会话的备忘是两个文件，互相看不见', () => {
    // 这是本层存在的理由。原来只有一个 `memo.json`，任何会话都能读到别人的备忘 —— 分账靠"读的时候
    // 过滤"，而文件是同一份。现在路径就不同。
    new MemoStore(dir, SESS).add('A 会话记的', 'user');
    const other = new MemoStore(dir, OTHER);
    assert.deepEqual(other.list(), [], 'B 会话不该看到 A 的备忘');
    other.add('B 会话记的', 'agent');
    assert.deepEqual(new MemoStore(dir, SESS).list().map((e) => e.text), ['A 会话记的'], 'A 也不该看到 B 的');
    // 两个文件都在盘上，各自只有自己的内容。
    assert.equal(existsSync(join(dir, '.she', 'sessions', SESS, 'memo.json')), true);
    assert.equal(existsSync(join(dir, '.she', 'sessions', OTHER, 'memo.json')), true);
  });

  it('【关键】非法会话 id 直接抛错，不会落到共享文件上', () => {
    // 兜底桶是所有会话共享的记忆，而且没人会发现 —— 这一层就是来根除这个形态的。
    assert.throws(() => new MemoStore(dir, ''), /不合法/);
    assert.throws(() => new MemoStore(dir, '../evil'), /不合法/);
  });

  it('rejects blank text at the tool and API boundary', async () => {    /*
     * The store itself will persist a blank entry (it trims and saves), so the
     * guarantee lives at the boundaries — both the tool and POST /api/memo
     * refuse empty text. Asserting it here means a removed guard shows up as a
     * failure instead of an invisible row in the memo panel.
     */
    const { createMemoTools } = await import('../memo-tools.js');
    const tools = createMemoTools(dir, SESS);
    const out = await tools.execute('memo_add', { text: '   ' });
    assert.match(out, /required|error/i, `空文本应被工具拒绝，实际: ${out}`);
    const viaMissing = await tools.execute('memo_add', {});
    assert.match(viaMissing, /required|error/i, '缺参数也应被拒绝');
    assert.equal(new MemoStore(dir, SESS).list().length, 0, '被拒绝的内容不应落盘');
  });
});

/**
 * `memo_list` 不能把「都做完了」说成「什么都没有」。
 *
 * 这是那条「备忘默认视图藏已完成条目」问题的另一半：UI 藏起来是看不到，工具藏起来是**说错话**。
 * 默认视图过滤掉已完成条目之后，一个「条目全都已完成」的备忘本会返回 `备忘录为空。` —— 一句关于
 * 世界的假话，而且是用模型最信任的那种口吻说的。听到这句话的 agent 会把已经记过的事再记一遍，
 * 或者向用户汇报「你从来没记过东西」。
 *
 * 下面几条钉的正是这个区别：空本子可以直说空，非空本子必须说明「有多少条被折叠了、怎么看」。
 */
describe('memo_list 的诚实性', () => {
  it('全部完成时不能谎称「为空」，要说出被折叠的条数', async () => {
    const { createMemoTools } = await import('../memo-tools.js');
    const store = new MemoStore(dir, SESS);
    const a = store.add('用户记的待办', 'user');
    const b = store.add('agent 记的待办', 'agent');
    store.update(a.id, { done: true });
    store.update(b.id, { done: true });

    const tools = createMemoTools(dir, SESS);
    const out = await tools.execute('memo_list', {});
    assert.doesNotMatch(out, /备忘录为空/, `两条已完成被当成了空本子: ${out}`);
    assert.match(out, /2/, `应说出被折叠的条数，实际: ${out}`);
    assert.match(out, /includeDone/, `应给出去看它们的办法，实际: ${out}`);
  });

  it('真的空才说空', async () => {
    const { createMemoTools } = await import('../memo-tools.js');
    const tools = createMemoTools(dir, SESS);
    assert.match(await tools.execute('memo_list', {}), /备忘录为空/);
  });

  it('只说「有 N 条已完成」不够，还要能把原文取回来', async () => {
    /*
     * 只报条数会让模型知道「有事没说」，却无法在需要时拿到它 —— 那就变成了另一种沉默。
     * includeDone=true 必须逐字还原，和 kb_query 的 full=true 是同一个约定。
     */
    const { createMemoTools } = await import('../memo-tools.js');
    const store = new MemoStore(dir, SESS);
    const done = store.add('这条已经完成但内容要紧：端口是 5577', 'user');
    store.update(done.id, { done: true });
    store.add('这条还没做', 'agent');

    const tools = createMemoTools(dir, SESS);
    const plain = await tools.execute('memo_list', {});
    assert.doesNotMatch(plain, /端口是 5577/, '默认视图不该列出已完成条目');
    assert.match(plain, /1/, `没做完的那条要列出来，实际: ${plain}`);

    const full = await tools.execute('memo_list', { includeDone: true });
    assert.match(full, /端口是 5577/, 'includeDone=true 必须逐字还原');
    assert.match(full, /\[x\]/, '已完成条目要有标记');
    assert.doesNotMatch(full, /已完成未列出/, '已经全列出来了就不该再提示折叠');
  });
});
