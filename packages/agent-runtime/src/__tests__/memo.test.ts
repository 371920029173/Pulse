/**
 * 工作区级的草稿板（memo）—— 用户和这个工作区里的 agent 都能改。
 *
 * 小接口，但它是"双方并发写"的唯一一处，所以顺序与持久化保证才是重点。
 *
 * 2026-10-01 起它按**工作区**分文件（`.she/memo.json`）：同一个项目里所有会话共用一本 —— 在一个项目里
 * 新开一个对话，昨天记的待办还在。2026-09-27 曾按会话分文件，那条边界划错了：备忘记的本来就是"这个项目
 * 里还没做的事"，按对话分账等于每次开新对话都从空开始。跨工作区仍然是两个根目录下的两份文件，路径上就
 * 看不见对方，所以本文件把"同项目共享 / 跨项目隔离"钉成性质。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoStore, adoptSessionMemosIntoWorkspace } from '../memo-tools.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-memo-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** 工作区级备忘的落点。写死在这里，是为了让"换了位置"时这个文件先红。 */
const MEMO_FILE = () => join(dir, '.she', 'memo.json');

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
    writeFileSync(MEMO_FILE(), '{ not json', 'utf8');
    assert.deepEqual(store.list(), [], '坏文件应降级为空列表而不是抛异常');
    // And the store must still be usable afterwards.
    store.add('仍然可用');
    assert.equal(store.list().length, 1);
  });

  it('tolerates a UTF-8 BOM in the store file', () => {
    const store = new MemoStore(dir);
    store.add('原始');
    const body = readFileSync(MEMO_FILE(), 'utf8');
    // PowerShell's Set-Content writes a BOM; an earlier parser choked on it.
    writeFileSync(MEMO_FILE(), '\uFEFF' + body, 'utf8');
    assert.equal(store.list().length, 1, '带 BOM 的文件应能被解析');
  });

  it('【关键】同一个项目的会话共用一本备忘', () => {
    new MemoStore(dir).add('A 会话记的', 'user');
    // 同一个工作区里再开一个 store，等价于"新开一个对话"：看到的是同一本，不是空的。
    assert.deepEqual(
      new MemoStore(dir).list().map((e) => e.text),
      ['A 会话记的'],
      '同一项目里新开一个对话不该看不到昨天记的东西',
    );
  });

  it('【关键】换一个工作区就看不见了（边界在项目上，不在对话上）', () => {
    new MemoStore(dir).add('这个项目记的', 'user');
    const otherRoot = mkdtempSync(join(tmpdir(), 'she-memo-other-'));
    try {
      assert.deepEqual(new MemoStore(otherRoot).list(), [], '另一个工作区不该看到这份备忘');
      // 它连文件都还没有 —— 隔离是靠路径，不是靠读的时候过滤。
      assert.equal(existsSync(join(otherRoot, '.she', 'memo.json')), false);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('落点是 `.she/memo.json`，不再建会话目录', () => {
    new MemoStore(dir).add('x');
    assert.equal(existsSync(MEMO_FILE()), true);
    assert.equal(existsSync(join(dir, '.she', 'sessions')), false, '工作区级的备忘不该再建会话目录');
  });

  it('迁移：把 2026-09-27 留下的会话私有备忘并回工作区那一份', () => {
    // 模拟那段时间留下的文件：`.she/sessions/<id>/memo.json`。
    const legacy = join(dir, '.she', 'sessions', 'sess_old', 'memo.json');
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify([{
      id: 'm_legacy1',
      text: '旧会话记的',
      author: 'user',
      done: false,
      createdAt: '2026-09-27T00:00:00.000Z',
      updatedAt: '2026-09-27T00:00:00.000Z',
    }]), 'utf8');
    new MemoStore(dir).add('工作区已经有的');

    const first = adoptSessionMemosIntoWorkspace(dir);
    assert.equal(first.adopted, 1, '应收回 1 条');
    assert.deepEqual(
      new MemoStore(dir).list().map((e) => e.text).sort(),
      ['工作区已经有的', '旧会话记的'].sort(),
      '两边的条目都该在',
    );
    // 原文件不删：迁移不该是单向门。
    assert.equal(existsSync(legacy), true, '迁移后原文件应保留');
    // 可重复执行。
    assert.deepEqual(adoptSessionMemosIntoWorkspace(dir), { adopted: 0, updated: 0 }, '再跑一次应是空操作');
  });

  it('rejects blank text at the tool and API boundary', async () => {    /*
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
    const store = new MemoStore(dir);
    const a = store.add('用户记的待办', 'user');
    const b = store.add('agent 记的待办', 'agent');
    store.update(a.id, { done: true });
    store.update(b.id, { done: true });

    const tools = createMemoTools(dir);
    const out = await tools.execute('memo_list', {});
    assert.doesNotMatch(out, /备忘录为空/, `两条已完成被当成了空本子: ${out}`);
    assert.match(out, /2/, `应说出被折叠的条数，实际: ${out}`);
    assert.match(out, /includeDone/, `应给出去看它们的办法，实际: ${out}`);
  });

  it('真的空才说空', async () => {
    const { createMemoTools } = await import('../memo-tools.js');
    const tools = createMemoTools(dir);
    assert.match(await tools.execute('memo_list', {}), /备忘录为空/);
  });

  it('只说「有 N 条已完成」不够，还要能把原文取回来', async () => {
    /*
     * 只报条数会让模型知道「有事没说」，却无法在需要时拿到它 —— 那就变成了另一种沉默。
     * includeDone=true 必须逐字还原，和 kb_query 的 full=true 是同一个约定。
     */
    const { createMemoTools } = await import('../memo-tools.js');
    const store = new MemoStore(dir);
    const done = store.add('这条已经完成但内容要紧：端口是 5577', 'user');
    store.update(done.id, { done: true });
    store.add('这条还没做', 'agent');

    const tools = createMemoTools(dir);
    const plain = await tools.execute('memo_list', {});
    assert.doesNotMatch(plain, /端口是 5577/, '默认视图不该列出已完成条目');
    assert.match(plain, /1/, `没做完的那条要列出来，实际: ${plain}`);

    const full = await tools.execute('memo_list', { includeDone: true });
    assert.match(full, /端口是 5577/, 'includeDone=true 必须逐字还原');
    assert.match(full, /\[x\]/, '已完成条目要有标记');
    assert.doesNotMatch(full, /已完成未列出/, '已经全列出来了就不该再提示折叠');
  });
});
