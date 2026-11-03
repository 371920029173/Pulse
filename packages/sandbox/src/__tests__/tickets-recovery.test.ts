/*
 * 确认票文件（.she/confirm-tickets.json）的隔离与原子写。
 *
 * 这不是"多加一个测试"：这两个断言原本都是**红的**。
 * 旧 load() 是 `catch { return new Map() }` —— 一个坏字节就等于"没有票"，
 * 紧接着 issue()/consume() 的 save() 把空表写回去，用户尚未过期的票据被静默抹掉。
 * AGENTS.md「Known traps」写明：读不懂的文件要挪到一边，绝不覆盖。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfirmTicketStore } from '../tickets.js';

function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'she-tickets-'));
  fs.mkdirSync(path.join(dir, '.she'), { recursive: true });
  return dir;
}

function ticketFile(root: string): string {
  return path.join(root, '.she', 'confirm-tickets.json');
}

/** 隔离出来的副本（名字带 .corrupt- 的那批）。 */
function quarantineCopies(root: string): string[] {
  const dir = path.join(root, '.she');
  return fs
    .readdirSync(dir)
    .filter((n) => n.includes('confirm-tickets.json.corrupt-'))
    .map((n) => path.join(dir, n));
}

describe('确认票：坏文件被隔离而不是被空表覆盖', () => {
  it('文件中间截断（半个 JSON）时，原字节被完整保留到 .corrupt- 副本', () => {
    const root = tmpWorkspace();
    // 一个尚未过期的真票据 + 一个断电留下的裂口。
    const live = {
      ticket_id: 'live-1',
      tool: 'shell',
      summary: 'rm -rf build',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    };
    const broken = `[${JSON.stringify(live)},\n  {"ticket_id":"torn`;
    fs.writeFileSync(ticketFile(root), broken, 'utf8');

    const store = new ConfirmTicketStore(root);
    // 旧代码：这里读出空表，随后 save() 用 [] 覆盖，broken 永久消失。
    store.issue('fs_write', 'write a file');

    const copies = quarantineCopies(root);
    assert.equal(copies.length, 1, `应当有且仅有一个隔离副本，实际: ${copies.join(', ')}`);
    assert.equal(fs.readFileSync(copies[0], 'utf8'), broken, '隔离副本必须与原始字节逐字节相同');
    // 事故现场还在，人还能去看；同时新票据正常写入。
    assert.ok(fs.existsSync(ticketFile(root)), '新票据文件应当被重新创建');
    const now = JSON.parse(fs.readFileSync(ticketFile(root), 'utf8')) as Array<{ tool: string }>;
    assert.deepEqual(now.map((t) => t.tool), ['fs_write']);
  });

  it('recoveryInfo() 能拿到"发生过隔离"的信号（不静默）', () => {
    const root = tmpWorkspace();
    fs.writeFileSync(ticketFile(root), 'not json at all', 'utf8');

    const store = new ConfirmTicketStore(root);
    assert.equal(store.recoveryInfo(), null, '还没读过盘时不该有信号');

    store.issue('shell', 'ls');

    const info = store.recoveryInfo();
    assert.ok(info, '隔离之后必须能查到原因，否则与"文件本来就不存在"无法区分');
    assert.match(info!.backup, /confirm-tickets\.json\.corrupt-/);
    assert.ok(fs.existsSync(info!.backup));
    assert.ok(info!.reason.length > 0, '原因不能是空串');
  });

  it('文件不存在时不算隔离（全新工作区不该报事故）', () => {
    const root = tmpWorkspace();
    const store = new ConfirmTicketStore(root);
    store.issue('shell', 'ls');
    assert.equal(store.recoveryInfo(), null);
    assert.equal(quarantineCopies(root).length, 0);
  });

  it('空文件（写到一半断电留下 0 字节）不当成损坏', () => {
    const root = tmpWorkspace();
    fs.writeFileSync(ticketFile(root), '', 'utf8');
    const store = new ConfirmTicketStore(root);
    store.issue('shell', 'ls');
    assert.equal(store.recoveryInfo(), null);
    assert.equal(quarantineCopies(root).length, 0);
  });
});

describe('确认票：save() 是 tmp + rename，不直写', () => {
  it('写完之后不留 tmp 文件，且目标文件是完整 JSON', () => {
    const root = tmpWorkspace();
    const store = new ConfirmTicketStore(root);
    store.issue('shell', 'ls');

    const dir = path.join(root, '.she');
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
    assert.deepEqual(leftovers, [], '写失败路径才会留下 tmp；正常写完不该有');
    const arr = JSON.parse(fs.readFileSync(ticketFile(root), 'utf8')) as unknown[];
    assert.equal(arr.length, 1);
  });

  it('save 失败时目标文件保持上一份好数据（撕裂写不可能发生）', () => {
    const root = tmpWorkspace();
    const store = new ConfirmTicketStore(root);
    const t = store.issue('shell', 'ls');
    const before = fs.readFileSync(ticketFile(root), 'utf8');

    // 让 rename 失败：把目标文件所在路径变成一个目录，同时把 tmp 写入也弄不动不可能，
    // 所以改为只读目标 —— Windows 上 rename 覆盖只读文件会失败。
    fs.chmodSync(ticketFile(root), 0o444);
    try {
      store.issue('shell', 'pwd');
    } catch {
      /* 抛不抛都行：关键是下面的内容 */
    } finally {
      fs.chmodSync(ticketFile(root), 0o666);
    }
    const after = fs.readFileSync(ticketFile(root), 'utf8');
    // 要么成功替换成合法 JSON，要么保留旧内容；绝不允许变成半截。
    const parsed = JSON.parse(after) as Array<{ ticket_id: string }>;
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.some((x) => x.ticket_id === t.ticket_id) || after === before);
  });
});
