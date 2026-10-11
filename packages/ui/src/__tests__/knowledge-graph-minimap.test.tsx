/**
 * s5 的判据：小地图（用户要的「地铁导览图」）。
 *
 * 验三件用户真能看见的事：
 *   ① 整层缩略 + 一个圈出当前视野的方框；放大主视图，方框要变小（看到的世界范围更小）
 *      —— 注意方向：k=1 时视野框已经顶满整张小地图（边界就是它自己），所以往缩小方向验不出变化，
 *         要往放大方向验。
 *   ② 点小地图 = 把主视图移过去（主视图的 transform 真的变了）
 *   ③ 可折叠，且折叠状态记在 sessionStorage
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { KnowledgeGraph } from '../components/KnowledgeGraph';

const TREE = [{
  id: 'root1', name: '项目甲', children: [
    { id: 'A', name: 'A', children: [{ id: 'A1', name: 'A1', children: [] }] },
    { id: 'B', name: 'B', children: [] },
  ],
}];

function stubKb() {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    const body = url.includes('/api/kb/tree') ? { tree: TREE }
      : url.includes('/api/kb/groups/root1') ? { group: { id: 'root1', name: '项目甲' }, children: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }], memories: [] }
      : url.includes('/api/kb/groups/') ? { group: { id: 'A', name: 'A' }, children: [], memories: [] }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch);
}

const flush = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

const mini = (c: HTMLElement) => c.querySelector('[aria-label*="小地图"]');
const board = (c: HTMLElement) => c.querySelector('div[class*="board"]') as HTMLElement;
const worldGroup = (c: HTMLElement) => c.querySelector('svg[class*="canvas"] g') as SVGGElement;

afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('知识图谱（s5：地铁导览图式小地图）', () => {
  it('小地图在，且放大主视图之后视野方框变小', async () => {
    stubKb();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();

    const map = mini(view.container);
    expect(map).toBeTruthy();
    const rect = map!.querySelector('rect');
    expect(rect).toBeTruthy();
    const w0 = Number(rect!.getAttribute('width'));
    expect(w0).toBeGreaterThan(0);

    // 滚轮往上 = 放大（看到的世界范围更小）→ 小地图上的方框要变小
    await act(async () => { fireEvent.wheel(board(view.container), { deltaY: -600 }); });
    const w1 = Number(rect!.getAttribute('width'));
    expect(w1).toBeLessThan(w0);
  });

  it('点小地图就把主视图移过去（主视图 transform 真的变了）', async () => {
    stubKb();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();

    const before = worldGroup(view.container).getAttribute('transform');
    await act(async () => { fireEvent.mouseDown(mini(view.container)!, { clientX: 20, clientY: 30 }); });
    const after = worldGroup(view.container).getAttribute('transform');
    expect(after).not.toBe(before);
    expect(after).toContain('translate(');
  });

  it('可折叠，状态记在 sessionStorage', async () => {
    stubKb();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    expect(mini(view.container)).toBeTruthy();

    const hide = Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent === '隐藏小地图')!;
    await act(async () => { fireEvent.click(hide); });
    expect(mini(view.container)).toBeNull();
    expect(sessionStorage.getItem('she.graph.minimap')).toBe('0');

    const show = Array.from(view.container.querySelectorAll('button')).find((b) => b.textContent === '小地图')!;
    await act(async () => { fireEvent.click(show); });
    expect(mini(view.container)).toBeTruthy();
    expect(sessionStorage.getItem('she.graph.minimap')).toBe('1');
  });
});
