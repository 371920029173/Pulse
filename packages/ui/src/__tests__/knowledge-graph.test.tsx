/**
 * s2 的判据：白板能看、能走、能拖。
 *
 * 重点在"走"的语义（用户给的 A/B/C/D/E/F 例子）：进入 A 之后，A 是当前层、C/D 是正常色、
 * B/E/F 变灰；双击祖先回到那一层；"上一级"回到父层。拖动只改视图位置，不碰任何数据。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { KnowledgeGraph } from '../components/KnowledgeGraph';

/** 根 → A(A1) , B(B1, B2)：用来验"当前层 / 可返回的祖先 / 变灰的其余"。 */
const TREE = [{
  id: 'root1', name: '项目甲', children: [
    { id: 'A', name: 'A', children: [{ id: 'A1', name: 'A1', children: [] }] },
    { id: 'B', name: 'B', children: [{ id: 'B1', name: 'B1', children: [] }, { id: 'B2', name: 'B2', children: [] }], },
  ],
}];
const LEVEL_A = { group: { id: 'A', name: 'A' }, children: [{ id: 'A1', name: 'A1' }], memories: [{ id: 'm1', title: '一条记忆' }] };

function installFetch() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    // 用 includes：无论 fetchJSON 有没有给路径加前缀都能命中
    const body = url.includes('/api/kb/tree') ? { roots: TREE }
      : url.includes('/api/kb/groups/A') ? LEVEL_A
      : url.includes('/api/kb/groups/root1') ? { group: { id: 'root1', name: '项目甲' }, children: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }], memories: [] }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch);
  return { calls };
}

const node = (c: HTMLElement, name: string) =>
  Array.from(c.querySelectorAll('g[role="button"]')).find((g) => (g.getAttribute('aria-label') ?? '').includes(name));

const flush = async () => {
  // 两拍：fetchJSON 链上有 fetch → res.ok → res.json() 几个 await，一拍不一定够
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => { vi.unstubAllGlobals(); });

describe('知识图谱白板（s2：看与走）', () => {
  it('画出顶层组，并把子组画出来；双击进入后当前层换人', async () => {
    installFetch();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    // 看文本而不是 svg 选择器：失败时会把实际渲染内容打出来（现在正需要这个信息）
    expect(view.container.textContent ?? '').toContain('项目甲');
    expect(node(view.container, '项目甲')).toBeTruthy();
    expect(node(view.container, 'A')).toBeTruthy();
    expect(node(view.container, 'B')).toBeTruthy();

    await act(async () => { fireEvent.doubleClick(node(view.container, 'A')!); });
    await flush();
    // 进 A 后：A 是当前、A1 与记忆是当前层
    expect(node(view.container, 'A1')).toBeTruthy();
    expect(node(view.container, '一条记忆')).toBeTruthy();
  });

  it('进入 A 之后：A 标亮、C/D 正常、B/E/F 变灰（用户给的语义）', async () => {
    installFetch();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    await act(async () => { fireEvent.doubleClick(node(view.container, 'A')!); });
    await flush();

    const clsOf = (name: string) => node(view.container, name)!.getAttribute('class') ?? '';
    expect(clsOf('A')).toContain('current');
    expect(clsOf('A1')).toContain('scope');
    expect(clsOf('B')).toContain('dim');
    expect(clsOf('B1')).toContain('dim');
    expect(clsOf('一条记忆')).toContain('scope');
  });

  it('"上一级"回到父层；双击祖先也能回到那一层', async () => {
    const { calls } = installFetch();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    await act(async () => { fireEvent.doubleClick(node(view.container, 'A')!); });
    await flush();
    await act(async () => { fireEvent.click(view.container.querySelector('button[class*="chip"]')!); });
    await flush();
    expect(node(view.container, 'A')).toBeTruthy();
    expect(calls.some((u) => u.includes('/api/kb/groups/root1'))).toBe(true);

    await act(async () => { fireEvent.doubleClick(node(view.container, 'A')!); });
    await flush();
    await act(async () => { fireEvent.doubleClick(node(view.container, '项目甲')!); });   // 双击祖先
    await flush();
    expect(node(view.container, 'A')).toBeTruthy();
  });

  it('拖动只改位置，不发任何请求', async () => {
    const { calls } = installFetch();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    const before = calls.length;
    const g = node(view.container, 'A')!;
    const transform0 = g.getAttribute('transform');
    await act(async () => {
      fireEvent.pointerDown(g, { clientX: 10, clientY: 10, pointerId: 1 });
      fireEvent.pointerMove(view.container.querySelector('div[class*="board"]')!, { clientX: 120, clientY: 90, pointerId: 1 });
      fireEvent.pointerUp(view.container.querySelector('div[class*="board"]')!, { pointerId: 1 });
    });
    const after = node(view.container, 'A')!.getAttribute('transform');
    expect(after).not.toBe(transform0);
    expect(calls.length).toBe(before);
  });
});
