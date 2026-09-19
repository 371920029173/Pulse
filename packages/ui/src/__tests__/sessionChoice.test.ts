/**
 * Which conversation a window shows.
 *
 * These tests pin a rule that was wrong for a long time and failed silently: the server keeps
 * one global active session, and the UI re-adopted it on every refresh. So a window's
 * conversation could be replaced underneath it — by a second window picking its own chat, or by
 * a scheduled task activating the session it works in. Nothing errored; the user simply found
 * themselves reading a different conversation.
 *
 * The rule is one line, which is exactly why it needs tests: "adopt only when this window has
 * no choice of its own" is easy to state and easy to get subtly wrong.
 */
import { describe, it, expect } from 'vitest';
import { pickActiveSession, isSessionKnown } from '../lib/sessionChoice';

describe('pickActiveSession', () => {
  it('【关键】本地已选会话时不会被服务端的 active 拽走', () => {
    // The bug this exists for: window A is reading X, window B selects Y (server active = Y),
    // and A's refresh — which runs on both edges of every turn — pulled A onto Y.
    expect(pickActiveSession('sess_X', false, 'sess_Y')).toBe('sess_X');
  });

  it('没有本地选择时才采纳服务端的 active（新窗口的起点）', () => {
    expect(pickActiveSession(null, false, 'sess_Y')).toBe('sess_Y');
  });

  it('服务端也没有 active 时保持为空', () => {
    expect(pickActiveSession(null, false, null)).toBeNull();
  });

  it('本地有选择时，服务端为 null 也不会清掉本地选择', () => {
    // A scheduled task finishing clears the server's active; the user's window must not
    // go blank because of it.
    expect(pickActiveSession('sess_X', false, null)).toBe('sess_X');
  });

  it('【关键】在讨论群里时不会被塞进一个单聊会话', () => {
    // Cluster mode deliberately sets the session selection to null. Adopting the server's
    // active there would set a session behind the group, which then resurfaces when the
    // group is closed — the user lands in a conversation they never picked.
    expect(pickActiveSession(null, true, 'sess_Y')).toBeNull();
  });

  it('在讨论群里时不会保留单聊会话（进入群时会清空，这是既有设计）', () => {
    /*
     * `handleSelectSession` clears the single-chat selection when a group is opened, so the
     * cluster branch here is a guard rather than a transformation: whatever the server says,
     * a group view must not end up with a session set behind it.
     *
     * Restoring the previous conversation when the group is closed would be an improvement,
     * but it is a different change (it means the selection must survive in state that the
     * render layer ignores), and asserting it here would be testing behaviour this function
     * does not provide.
     */
    expect(pickActiveSession('sess_X', true, 'sess_Y')).toBeNull();
  });

  it('返回值只可能是本地选择或服务端选择，不会凭空产生 id', () => {
    const cases: Array<[string | null, boolean, string | null]> = [
      ['a', false, 'b'], [null, false, 'b'], [null, false, null], ['a', true, 'b'], [null, true, null],
    ];
    for (const [local, inCluster, server] of cases) {
      const out = pickActiveSession(local, inCluster, server);
      expect([local, server, null]).toContain(out);
    }
  });
});

describe('isSessionKnown', () => {
  it('没有本地选择时视为可用（交给 pickActiveSession 决定）', () => {
    expect(isSessionKnown(null, ['a', 'b'])).toBe(true);
  });

  it('本地选择在列表里则可用', () => {
    expect(isSessionKnown('a', ['a', 'b'])).toBe(true);
  });

  it('本地选择已不存在则判为过期（在别处被删掉了）', () => {
    expect(isSessionKnown('gone', ['a', 'b'])).toBe(false);
  });

  it('【关键】列表还没加载时不判过期', () => {
    // Otherwise every reload would throw away the restored selection before the list arrived,
    // and the window would jump to the server's active session — the exact bug being fixed.
    expect(isSessionKnown('a', [])).toBe(true);
  });

  it('空列表 + 空选择也算可用', () => {
    expect(isSessionKnown(null, [])).toBe(true);
  });
});
