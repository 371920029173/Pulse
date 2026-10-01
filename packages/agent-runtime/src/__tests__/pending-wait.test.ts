import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeWaiting } from '../pending-wait.js';

/**
 * 「在等谁」这件事要能被确定地断言。
 *
 * 这里刻意不经过 Agent：等确认/等应用补丁的**过期**分支如果只能靠等 120 秒的 TTL 去测，那它实际上就
 * 不会被测 —— 而"工单过期之后这一轮还停着"正是最容易读错的一件（一张过期的工单看起来像"结束了"）。
 * 所以判定做成纯函数、`now` 是入参，过期这件事在这里是确定的一步，不是一次等待。
 */
describe('describeWaiting：这一轮停着等谁', () => {
  const ticket = {
    tool: 'shell',
    summary: 'rm -rf build',
    created_at: '2026-10-01T10:00:00.000Z',
    expires_at: '2026-10-01T10:02:00.000Z',
  };
  const during = Date.parse('2026-10-01T10:01:00.000Z');
  const after = Date.parse('2026-10-01T10:05:00.000Z');

  test('没停着的时候没有可报的等待', () => {
    assert.equal(describeWaiting(null, null), null);
    // 关键的一半：**停着**才是"在等谁"的来源，光有一张工单不算。
    assert.equal(describeWaiting(null, ticket), null);
  });

  test('停着等确认：说出等谁、从什么时候起、还没过期', () => {
    const w = describeWaiting('confirm', ticket, during);
    assert.ok(w);
    assert.equal(w.kind, 'confirm');
    assert.equal(w.waitingOn, 'user');
    assert.equal(w.since, ticket.created_at, '开始等的时刻取工单自己的 created_at，不另记一份');
    assert.equal(w.expiresAt, ticket.expires_at);
    assert.equal(w.expired, false);
    assert.match(w.note, /等你/, '话里必须点名在等人');
  });

  test('【关键】工单过期：这一轮仍然停着，而不是"结束了"', () => {
    const w = describeWaiting('confirm', ticket, after);
    assert.ok(w);
    assert.equal(w.expired, true, '过期是一个能被判断的值');
    assert.equal(w.waitingOn, 'user', '过期的工单不是"没有人可等"');
    assert.match(w.note, /仍然停着/, '必须说清它没结束：过期 != 这一轮结束');
    assert.match(w.note, /不会自行批准/, '也不能读成"过一会儿它自己接着做"');
    assert.match(w.note, /重新发起|停掉/, '要给出接下来怎么办，否则这句话只是通知');
  });

  test('等应用补丁：没有工单也说得出来（那条路没有 ticket）', () => {
    const w = describeWaiting('apply', null, during);
    assert.ok(w);
    assert.equal(w.kind, 'apply');
    assert.equal(w.since, null);
    assert.equal(w.expired, false, '没有 expires_at 就不该声称过期');
    assert.match(w.note, /补丁/);
  });

  test('工单没有 expires_at 时不许声称过期', () => {
    const w = describeWaiting('confirm', { ...ticket, expires_at: undefined }, after);
    assert.ok(w);
    assert.equal(w.expired, false);
  });
});
