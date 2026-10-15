/**
 * 界面状态跨重启的判据（用户报的："这个玩意还是每次重启都弹"、"下次打开希望还能看到这些字"）。
 *
 * 桌面端每个窗口的后端端口每次启动都可能变（Hyper-V 保留端口段 → 向系统要端口），而 localStorage 按
 * origin 隔离 —— 所以这份状态必须落到工作区（.she/ui-state.json）并由这里负责来回搬。
 * 三件事：凭据永不参与；启动灌回；之后整份送回（删除发 null，不把别的键抹掉）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushUiState, hydrateUiState, snapshotUiState } from '../lib/uiState';

beforeEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('界面状态：跟工作区走，不跟端口走', () => {
  it('快照只收 she.*，且**永不**包含凭据', () => {
    localStorage.setItem('she.draft.sess_a', '没发出去的一句话');
    localStorage.setItem('she.thinkingLevel', 'high');
    localStorage.setItem('she.authToken', 'sk-secret');
    localStorage.setItem('other.key', 'nope');
    const snap = snapshotUiState();
    expect(snap['she.draft.sess_a']).toBe('没发出去的一句话');
    expect(snap['she.thinkingLevel']).toBe('high');
    expect(snap['she.authToken'], '凭据落到了状态文件里').toBeUndefined();
    expect(snap['other.key']).toBeUndefined();
  });

  it('启动时把服务端那份灌回 localStorage（渲染前）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      state: { 'she.draft.sess_a': '上次没发出去的字', 'she.thinkingLevel': 'high' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await hydrateUiState();
    expect(localStorage.getItem('she.draft.sess_a')).toBe('上次没发出去的字');
    expect(localStorage.getItem('she.thinkingLevel')).toBe('high');
  });

  it('送回时只带变化；被清掉的键发 null（删除），不是整份覆盖', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      if (init?.method === 'PUT') bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    // 第一次：两个新键
    localStorage.setItem('she.draft.sess_a', '一句话');
    localStorage.setItem('she.thinkingLevel', 'high');
    await flushUiState();
    // 第二次：清掉推理档位（发 null），其余不变（不发）
    localStorage.removeItem('she.thinkingLevel');
    await flushUiState();
    expect(bodies.length, '变化的两次都应该送出去').toBe(2);
    expect((bodies[0] as { entries: Record<string, unknown> }).entries['she.draft.sess_a']).toBe('一句话');
    expect((bodies[1] as { entries: Record<string, unknown> }).entries['she.thinkingLevel'], '删除没有发 null').toBeNull();
    expect(Object.keys((bodies[1] as { entries: Record<string, unknown> }).entries)).toEqual(['she.thinkingLevel']);
  });

  it('服务端不可达：不抛、不阻断（退回老行为）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(hydrateUiState()).resolves.toBeUndefined();
    localStorage.setItem('she.draft.sess_a', 'x');
    await expect(flushUiState()).resolves.toBe(false);
  });
});
