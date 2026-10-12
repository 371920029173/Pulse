/**
 * s2 的判据：白板能看、能走、能拖。
 *
 * 重点在"走"的语义（用户给的 A/B/C/D/E/F 例子）：进入 A 之后，A 是当前层、C/D 是正常色、
 * B/E/F 变灰；双击祖先回到那一层；"上一级"回到父层。拖动只改视图位置，不碰任何数据。
 *
 * s3 追加的判据：操作序列（改名/复制/剪切/粘贴/新建/并入）在确认之前一个字节都不落库；
 * 右键菜单与 Ctrl+C/X/V、F2、Enter、Backspace 都作用在**选中的节点**上，
 * 且 Escape 分两级（先关菜单，再关面板）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
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
  /** 写请求（方法 + 路径 + body）—— s3 全靠它来证明"什么时候才真的落库"。 */
  const writes: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.method && init.method !== 'GET') {
      writes.push({ method: init.method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    }
    if (url.includes('/api/kb/batch')) {
      return new Response(JSON.stringify({ snapshot: '.she/kb-snapshots/snap.sqlite', applied: 1, failedAt: null, error: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/api/kb/rollback')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    /* 形状抄服务端：GET /api/kb/memories/:id → { memory: { id, title, content }, retired, version, history }
       （以前这里是编的 { id, title, content }，把真机上的空白编辑器放过去了） */
    if (/\/api\/kb\/memories\//.test(url)) {
      return new Response(JSON.stringify({ memory: { id: 'm1', title: '一条记忆', content: '正文原文' }, retired: null, version: 1, history: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // 用 includes：无论 fetchJSON 有没有给路径加前缀都能命中
    // 真形状来自服务端：GET /api/kb/tree → { tree: […] }（不是 roots —— 那个字段是我编的）
    const body = url.includes('/api/kb/tree') ? { tree: TREE }
      : url.includes('/api/kb/groups/A') ? LEVEL_A
      : url.includes('/api/kb/groups/root1') ? { group: { id: 'root1', name: '项目甲' }, children: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }], memories: [] }
      : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch);
  return { calls, writes };
}

const node = (c: HTMLElement, name: string) =>
  Array.from(c.querySelectorAll('g[role="button"]')).find((g) => (g.getAttribute('aria-label') ?? '').includes(name));

/** 菜单里的按钮：菜单项 = 标签 + 快捷键提示两个 span，所以用 includes 找。 */
const menuBtn = (c: HTMLElement, label: string) => {
  const menu = c.querySelector('[role="menu"]');
  if (!menu) return undefined;
  return Array.from(menu.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(label));
};

const btn = (c: HTMLElement, label: string) =>
  Array.from(c.querySelectorAll('button')).find((b) => b.textContent === label);

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

describe('知识图谱（s3：操作序列 / 保存并确认 / 回滚）', () => {
  it('改名只进待同步：一个写请求都不发', async () => {
    const { writes } = installFetch();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    await act(async () => { fireEvent.click(node(view.container, 'A')!); });
    await act(async () => { fireEvent.click(btn(view.container, '改名')!); });
    const input = view.container.querySelector('#kg-rename') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: 'A改过' } }); });
    await act(async () => { fireEvent.click(btn(view.container, '加入待同步')!); });
    expect(view.container.textContent).toContain('待同步 1 项');
    expect(writes.length).toBe(0);
  });

  it('保存并确认是两段式：摊开确认条时不发请求，点确认才发一次 batch（body 带操作）', async () => {
    const { writes } = installFetch();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    await act(async () => { fireEvent.click(node(view.container, 'A')!); });
    await act(async () => { fireEvent.click(btn(view.container, '复制')!); });
    await act(async () => { fireEvent.click(btn(view.container, '粘贴到这里')!); });
    expect(view.container.textContent).toContain('待同步 1 项');

    await act(async () => { fireEvent.click(btn(view.container, '保存并确认')!); });
    expect(view.container.textContent).toContain('将按顺序应用 1 项改动');
    expect(writes.length).toBe(0);            // 确认条摊开时仍然不许落库

    await act(async () => { fireEvent.click(btn(view.container, '确认同步')!); });
    await flush();
    expect(writes.length).toBe(1);
    expect(writes[0].url).toContain('/api/kb/batch');
    const ops = (writes[0].body as { ops: Array<{ kind: string; id: string; parentId: string | null }> }).ops;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'copyGroup', id: 'A', parentId: null });
    expect(view.container.textContent).toContain('已同步 1 项改动');
  });

  it('同步之后出现回滚按钮，点了发 rollback 并带上那次快照', async () => {
    const { writes } = installFetch();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    await act(async () => { fireEvent.click(node(view.container, 'A')!); });
    await act(async () => { fireEvent.click(btn(view.container, '剪切')!); });
    await act(async () => { fireEvent.click(btn(view.container, '粘贴到这里')!); });
    await act(async () => { fireEvent.click(btn(view.container, '保存并确认')!); });
    await act(async () => { fireEvent.click(btn(view.container, '确认同步')!); });
    await flush();

    const rb = btn(view.container, '回滚到同步前') as HTMLButtonElement;
    expect(rb.disabled).toBe(false);
    await act(async () => { fireEvent.click(rb); });
    await flush();
    const rollback = writes.find((w) => w.url.includes('/api/kb/rollback'));
    expect(rollback).toBeTruthy();
    expect((rollback!.body as { snapshot: string }).snapshot).toContain('snap.sqlite');
    expect(view.container.textContent).toContain('已回滚到最近一次同步之前');
  });

  it('双击记忆打开正文编辑器，改过之后进待同步的是 updateMemory', async () => {
    const { writes } = installFetch();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    await act(async () => { fireEvent.doubleClick(node(view.container, 'A')!); });
    await flush();
    await act(async () => { fireEvent.doubleClick(node(view.container, '一条记忆')!); });
    await flush();
    const ta = view.container.querySelector('#kg-content') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    // 【关键】打开就要看得见**原本的内容**（标题与正文都是），不然等于盲改
    expect(ta.value).toBe('正文原文');
    expect((view.container.querySelector('#kg-title') as HTMLInputElement).value).toBe('一条记忆');
    await act(async () => { fireEvent.change(ta, { target: { value: '改过的正文' } }); });
    await act(async () => { fireEvent.click(btn(view.container, '加入待同步')!); });
    await act(async () => { fireEvent.click(btn(view.container, '保存并确认')!); });
    await act(async () => { fireEvent.click(btn(view.container, '确认同步')!); });
    await flush();
    const batch = writes.find((w) => w.url.includes('/api/kb/batch'));
    expect((batch!.body as { ops: Array<{ kind: string; content?: string }> }).ops[0]).toMatchObject({ kind: 'updateMemory', content: '改过的正文' });
  });
});

describe('知识图谱（s3：Windows 式右键菜单与快捷键）', () => {
  it('右键节点弹出菜单；菜单里点「复制」再「粘贴」只进待同步，不发写请求', async () => {
    const { writes } = installFetch();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();

    await act(async () => { fireEvent.contextMenu(node(view.container, 'A')!); });
    expect(view.container.querySelector('[role="menu"]')).toBeTruthy();
    // 菜单里那一项带着快捷键提示（Ctrl+C），这正是"像 Windows"的那部分
    expect(menuBtn(view.container, '复制')!.textContent).toContain('Ctrl+C');

    await act(async () => { fireEvent.click(menuBtn(view.container, '复制')!); });
    expect(view.container.querySelector('[role="menu"]')).toBeNull();   // 点过就收
    await act(async () => { fireEvent.contextMenu(node(view.container, 'A')!); });
    await act(async () => { fireEvent.click(menuBtn(view.container, '粘贴')!); });

    expect(view.container.textContent).toContain('待同步 1 项');
    expect(writes.length).toBe(0);
  });

  it('F2 改名、Ctrl+X 剪切 + Ctrl+V 粘贴：作用于选中的节点，且 Enter 能进入它', async () => {
    const { writes } = installFetch();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    await act(async () => { fireEvent.click(node(view.container, 'A')!); });

    // F2 → 改名框
    await act(async () => { fireEvent.keyDown(window, { key: 'F2' }); });
    expect(view.container.querySelector('#kg-rename')).toBeTruthy();
    await act(async () => { fireEvent.click(btn(view.container, '取消')!); });
    expect(view.container.querySelector('#kg-rename')).toBeNull();

    // Ctrl+X → 选中项进剪贴板（界面上有提示），Ctrl+V → 进待同步
    await act(async () => { fireEvent.keyDown(window, { key: 'x', ctrlKey: true }); });
    expect(view.container.textContent).toContain('剪贴板：A');
    await act(async () => { fireEvent.keyDown(window, { key: 'v', ctrlKey: true }); });
    expect(view.container.textContent).toContain('待同步 1 项');
    expect(writes.length).toBe(0);

    // 确认之后落库的是移动（剪切 + 粘贴 = moveGroup），且 id 是选中的 A
    await act(async () => { fireEvent.click(btn(view.container, '保存并确认')!); });
    await act(async () => { fireEvent.click(btn(view.container, '确认同步')!); });
    await flush();
    const batch = writes.find((w) => w.url.includes('/api/kb/batch'));
    expect((batch!.body as { ops: Array<{ kind: string; id: string }> }).ops[0]).toMatchObject({ kind: 'moveGroup', id: 'A' });
  });

  it('Escape 分两级：菜单开着时第一下只关菜单、面板还在，第二下才关面板', async () => {
    installFetch();
    const onClose = vi.fn();
    const view = render(<KnowledgeGraph onClose={onClose} />);
    await flush();

    await act(async () => { fireEvent.contextMenu(node(view.container, 'A')!); });
    expect(view.container.querySelector('[role="menu"]')).toBeTruthy();

    // 派发到 body：这才是真实事件的路径（window 捕获 → document 冒泡），
    // useEscapeToClose 挂在 document 上、靠 defaultPrevented 让路，这条断言正是在验那个约定
    await act(async () => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="dialog"]')).toBeTruthy();

    await act(async () => { fireEvent.keyDown(document.body, { key: 'Escape' }); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('在输入框里打字时白板快捷键让路（F2 不抢文字编辑）', async () => {
    installFetch();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    await act(async () => { fireEvent.click(node(view.container, 'A')!); });
    await act(async () => { fireEvent.click(btn(view.container, '新建子组')!); });
    const input = view.container.querySelector('#kg-newgroup') as HTMLInputElement;
    expect(input).toBeTruthy();

    // 焦点在输入框里：F2 应该什么都不做（否则改名框会顶掉正在输入的内容）
    await act(async () => { fireEvent.keyDown(input, { key: 'F2' }); });
    expect(view.container.querySelector('#kg-rename')).toBeNull();

    // 名字照样能进待同步
    await act(async () => { fireEvent.change(input, { target: { value: '新组' } }); });
    await act(async () => { fireEvent.click(btn(view.container, '加入待同步')!); });
    expect(view.container.textContent).toContain('待同步 1 项');
  });
});

describe('知识图谱（形状对不上要说出来）', () => {
  it('返回既不是数组也没有 tree 字段时，界面报错而不是静默空板', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ roots: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch);
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    expect(view.container.textContent).toContain('返回的形状不对');
  });
});

describe('知识图谱（标签：看得到内容）', () => {
  it('长路径的组按尾部截断并带上记忆条数，悬停有全名', async () => {
    /*
     * 用的是真实那一层的形状：project/digbug/findings/part-4、12 条记忆。
     * 旧的写法会渲染成 "project/digbug/fin…" —— 同一层每个标签都一样，等于没有信息。
     */
    const LONG = [{ id: 'g1', name: 'project/digbug/findings/part-4', children: [], memoryCount: 12 }];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      const body = url.includes('/api/kb/tree') ? { tree: LONG }
        : url.includes('/api/kb/groups/') ? { group: { id: 'g1', name: 'project/digbug/findings/part-4' }, children: [], memories: [] }
        : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch);

    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    const text = view.container.textContent ?? '';
    expect(text).toContain('…/findings/part-4');
    expect(text).toContain('· 12');
    expect(text).not.toContain('project/digbug/fin…');
    // 悬停能看到全名与条数（标签放不下整条路径）
    const g = node(view.container, 'part-4');
    expect(g?.querySelector('title')?.textContent ?? '').toContain('project/digbug/findings/part-4');
  });
});

describe('知识图谱（白板：不挤、有颜色、白底）', () => {
  /*
   * 用户的原话："这些点排列的有点密集，而且没啥颜色，背景也不是白的"。
   * 这三条守的就是这三件事 —— 旧算法拿固定半径估环周长，节点一多就挤成一圈、标签互相盖。
   */
  const WIDE = [{
    id: 'top', name: '顶层', memoryCount: 5, children: [
      { id: 'c1', name: 'project/alpha/findings/part-1', memoryCount: 40, children: [] },
      { id: 'c2', name: 'project/alpha/findings/part-2', memoryCount: 33, children: [] },
      { id: 'c3', name: 'project/alpha/lessons/part-1', memoryCount: 27, children: [] },
      { id: 'c4', name: 'project/alpha/lessons/part-2', memoryCount: 21, children: [] },
      { id: 'c5', name: 'project/beta/accounts', memoryCount: 18, children: [] },
      { id: 'c6', name: 'project/beta/measurements', memoryCount: 15, children: [] },
      { id: 'c7', name: 'architecture/testing', memoryCount: 12, children: [] },
      { id: 'c8', name: 'architecture/ui', memoryCount: 9, children: [] },
      { id: 'c9', name: 'host/windows', memoryCount: 6, children: [] },
      { id: 'c10', name: 'errors/shell', memoryCount: 3, children: [] },
    ],
  },
  /* 再来两支顶层：根视图里子组继承所在分支的颜色，一条分支只有一种色 —— fixture 得有好几支，
     才验得出"有颜色"。真库的顶层本来就分好几支。 */
  {
    id: 'top2', name: '第二支', memoryCount: 4, children: [
      { id: 'd1', name: '第二支/子组一', memoryCount: 8, children: [] },
      { id: 'd2', name: '第二支/子组二', memoryCount: 5, children: [] },
    ],
  },
  { id: 'top3', name: '第三支', memoryCount: 2, children: [
    { id: 'e1', name: '第三支/子组', memoryCount: 2, children: [] },
  ] }];

  function installWide() {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      const body = url.includes('/api/kb/tree') ? { tree: WIDE }
        : url.includes('/api/kb/groups/') ? { group: { id: 'top', name: '顶层' }, children: [], memories: [] }
        : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch);
  }

  /** 从 DOM 里读每个可见节点的圆心、半径与色相。 */
  const circles = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('g[role="button"]')).map((g) => {
      const m = /translate\((-?[\d.]+),(-?[\d.]+)\)/.exec(g.getAttribute('transform') ?? '');
      const all = g.querySelectorAll('circle');
      const node = all[all.length - 1];            // 当前节点会先画外环再画本体，取最后一个
      const hue = /--kg-hue:\s*([^;]+)/.exec(g.getAttribute('style') ?? '')?.[1]?.trim() ?? '';
      return { x: Number(m?.[1] ?? 0), y: Number(m?.[2] ?? 0), r: Number(node?.getAttribute('r') ?? 0), hue };
    });

  it('【关键】不挤：任意两个节点的圆心距 ≥ 两个半径之和', async () => {
    installWide();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    const ns = circles(view.container);
    expect(ns.length).toBeGreaterThan(8);
    const bad: string[] = [];
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const d = Math.hypot(ns[i].x - ns[j].x, ns[i].y - ns[j].y);
        if (d < ns[i].r + ns[j].r) bad.push('#' + i + '(' + ns[i].r + ') 与 #' + j + '(' + ns[j].r + ') 相距 ' + d.toFixed(1) + ' < ' + (ns[i].r + ns[j].r));
      }
    }
    expect(bad).toEqual([]);
  });

  it('有颜色：每个节点都拿到调色板色相，且不止一种', async () => {
    installWide();
    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    const ns = circles(view.container);
    expect(ns.length).toBeGreaterThan(8);
    expect(ns.every((n) => /^var\(--graph-node-[1-6]\)$/.test(n.hue))).toBe(true);
    expect(new Set(ns.map((n) => n.hue)).size).toBeGreaterThan(1);
  });

  it('白底：.board 用 --graph-paper，不再跟随会被壁纸吃掉的界面 token', () => {
    // 包内 cwd（pnpm --filter @she/ui test 与 pnpm -r test 都是它），再加一层仓库根兜底
    const candidates = ['src/styles/KnowledgeGraph.module.css', 'packages/ui/src/styles/KnowledgeGraph.module.css'];
    const file = candidates.find((c) => existsSync(c));
    expect(file, '找不到 KnowledgeGraph.module.css').toBeTruthy();
    const css = readFileSync(file as string, 'utf8');
    expect(css).toMatch(/\.board\s*\{[^}]*background:\s*var\(--graph-paper\)/);
    expect(css).not.toMatch(/\.board\s*\{[^}]*background:\s*var\(--bg-/);
  });
});

describe('知识图谱（打开记忆要看得见原本的内容）', () => {
  it('服务端返回的形状不对时：出提示，而不是开一个空编辑器', async () => {
    /*
     * 真实事故：组件按想当然的形状（平铺 title/content）读，服务端返回的却是 { memory: {…} } ——
     * 编辑器永远空白，用户看不到原本的内容。这条判据守"形状不对要说出来"，不许静默给空表单。
     */
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input);
      if (/\/api\/kb\/memories\//.test(url)) {
        // 故意给错形状（旧代码就是按这个读的）
        return new Response(JSON.stringify({ id: 'm1', title: '一条记忆', content: '正文原文' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const body = url.includes('/api/kb/tree') ? { tree: TREE }
        : url.includes('/api/kb/groups/A') ? LEVEL_A
        : url.includes('/api/kb/groups/root1') ? { group: { id: 'root1', name: '项目甲' }, children: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }], memories: [] }
        : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch);

    const view = render(<KnowledgeGraph onClose={() => {}} />);
    await flush();
    await act(async () => { fireEvent.doubleClick(node(view.container, 'A')!); });
    await flush();
    await act(async () => { fireEvent.doubleClick(node(view.container, '一条记忆')!); });
    await flush();
    expect(view.container.textContent ?? '').toContain('形状不对');
    expect(view.container.querySelector('#kg-content')).toBeNull();
  });
});
