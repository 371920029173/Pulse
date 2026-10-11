/**
 * s4 的判据：白板的快捷键**真的能在设置页改**，而且改完白板照着改后的走。
 *
 * 这条要跨两个组件验：先挂设置页改键（写 localStorage + 广播），再挂白板读键。
 * 只验设置页里那几行显示出来，等于只验了 UI 会画数组 —— 那证明不了"能改"。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { ShortcutEditor } from '../components/ShortcutEditor';
import { KnowledgeGraph } from '../components/KnowledgeGraph';

const TREE = [{
  id: 'root1', name: '项目甲', children: [
    { id: 'A', name: 'A', children: [] },
  ],
}];

function stubKb() {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    const body = url.includes('/api/kb/tree') ? { tree: TREE }
      : url.includes('/api/kb/groups/root1') ? { group: { id: 'root1', name: '项目甲' }, children: [{ id: 'A', name: 'A' }], memories: [] }
      : url.includes('/api/kb/groups/A') ? { group: { id: 'A', name: 'A' }, children: [], memories: [] }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch);
}

const node = (c: HTMLElement, name: string) =>
  Array.from(c.querySelectorAll('g[role="button"]')).find((g) => (g.getAttribute('aria-label') ?? '').includes(name));

const flush = async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('设置页：快捷键（s4）', () => {
  it('白板的键在设置页里列出来了，且 scope 标成「知识图谱」而不是「全局」', () => {
    const view = render(<ShortcutEditor />);
    expect(view.container.textContent).toContain('知识图谱');
    expect(view.container.textContent).toContain('改名');
    expect(view.container.textContent).toContain('上一级');
    // 三个 scope 的标签必须分得开（graph 曾显示成"全局"，那会让人以为 Enter 在全局都生效）
    expect(view.container.textContent).toContain('输入框');
    expect(view.container.textContent).toContain('全局');
  });

  it('改键写到 localStorage，白板读同一张表 —— F2 改 F6 之后，白板认 F6 不认 F2', async () => {
    // ① 在设置页把「改名」从 F2 改成 F6
    const editor = render(<ShortcutEditor />);
    const f2 = Array.from(editor.container.querySelectorAll('button')).find((b) => b.textContent === 'F2');
    expect(f2).toBeTruthy();                       // 默认键就在那儿
    await act(async () => { fireEvent.click(f2!); });
    await act(async () => { fireEvent.keyDown(window, { key: 'F6' }); });
    expect(JSON.parse(localStorage.getItem('she.shortcuts') ?? '{}')['graph.rename']).toBe('F6');
    editor.unmount();

    // ② 再开白板：只有 F6 能召唤改名框
    stubKb();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    await act(async () => { fireEvent.click(node(view.container, 'A')!); });

    await act(async () => { fireEvent.keyDown(window, { key: 'F2' }); });
    expect(view.container.querySelector('#kg-rename')).toBeNull();   // 旧键已经失效

    await act(async () => { fireEvent.keyDown(window, { key: 'F6' }); });
    expect(view.container.querySelector('#kg-rename')).toBeTruthy();  // 新键生效
  });
});
