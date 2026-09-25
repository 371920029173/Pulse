/**
 * The shared scratchpad panel — the half of "the memo view hides completed items" the user sees.
 *
 * The other half is in `agent-runtime`'s `memo.test.ts` (`memo_list` claiming the pad was empty). Both
 * had the same failure: an item that was written, and then ticked, silently stopped existing as far
 * as one of the two parties was concerned.
 *
 * Why this is worth a test rather than a one-line default flip:
 *
 *   - **A tick is not a deletion.** The memo is a record both sides write to, and the agent marks its
 *     own notes done when they no longer need attention. Hiding those meant the agent's finished work
 *     vanished from the only screen that shows it — a user reading that screen concludes nothing was
 *     ever written.
 *   - **"Nothing to show" and "nothing here" are different states.** The old code printed 还没有记录
 *     whenever the *filtered* list was empty, so a pad holding only completed items claimed to be
 *     untouched. That is the specific sentence that makes a user give up on the feature, and the
 *     distinction is invisible unless a test pins it.
 *   - **The toggle still has to fold them away.** The fix must not be "ignore the filter": anyone who
 *     wants the short view should still get it, and the pad must say where the folded items went
 *     rather than looking empty again.
 *
 * `fetchJSON` is mocked — these are properties of the view, not of the route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchJSON = vi.fn();
vi.mock('../lib/api', () => ({ fetchJSON: (...args: unknown[]) => fetchJSON(...args) }));

const { Memo } = await import('../components/Memo');

interface Entry { id: string; text: string; author: 'user' | 'agent'; done: boolean; createdAt: string; updatedAt: string }

const entry = (id: string, text: string, done: boolean, author: 'user' | 'agent' = 'agent'): Entry => ({
  id, text, done, author, createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
});

/** The panel polls `/api/memo`, so every call gets the same list unless a test says otherwise. */
const serve = (entries: Entry[]) => fetchJSON.mockResolvedValue({ entries });

describe('Memo 面板', () => {
  beforeEach(() => { fetchJSON.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('【关键】默认就能看到已完成条目（勾掉了不等于没写过）', async () => {
    serve([entry('m_1', '还没做的', false), entry('m_2', '已经做完的', true)]);

    render(<Memo />);

    expect(await screen.findByText('还没做的')).toBeTruthy();
    expect(await screen.findByText('已经做完的')).toBeTruthy();
  });

  it('【关键】只剩已完成条目时，不能说「还没有记录」', async () => {
    /*
     * The exact regression: every entry done, so the filtered list is empty, and the panel said
     * 还没有记录 — a false statement about a pad that has two entries in it.
     */
    serve([entry('m_1', '做完的第一条', true), entry('m_2', '做完的第二条', true)]);

    render(<Memo />);

    expect(await screen.findByText('做完的第一条')).toBeTruthy();
    expect(screen.queryByText(/还没有记录/)).toBeNull();
  });

  it('真的空才说「还没有记录」', async () => {
    serve([]);
    render(<Memo />);
    expect(await screen.findByText(/还没有记录/)).toBeTruthy();
  });

  it('折叠已完成之后，未完成的还在，计数也不说谎', async () => {
    serve([entry('m_1', '未完成', false), entry('m_2', '已完成', true)]);
    render(<Memo />);
    await screen.findByText('已完成');

    fireEvent.click(screen.getByText('隐藏完成'));

    await waitFor(() => expect(screen.queryByText('已完成')).toBeNull());
    expect(screen.getByText('未完成')).toBeTruthy();
    // 折叠之后列表非空，所以不该出现任何「空」的说法
    expect(screen.queryByText(/还没有记录/)).toBeNull();
    // 头部仍然报出被收起来的条数，用户知道它们没丢
    expect(screen.getByText(/待办/).textContent).toMatch(/1\s*已完成/);
  });

  it('【关键】折叠后一条不剩时，说的是「被折叠了」而不是「还没有记录」', async () => {
    /*
     * This is the sentence that matters. Both states render an empty list, and the old code said
     * 还没有记录 for both — which is how a pad full of finished notes read as an untouched one.
     */
    serve([entry('m_1', '做完的第一条', true), entry('m_2', '做完的第二条', true)]);
    render(<Memo />);
    await screen.findByText('做完的第一条');

    fireEvent.click(screen.getByText('隐藏完成'));

    await waitFor(() => expect(screen.queryByText('做完的第一条')).toBeNull());
    expect(screen.getByText(/已完成被折叠/)).toBeTruthy();
    expect(screen.queryByText(/还没有记录/)).toBeNull();
  });

  it('计数把待办与已完成分开，用户能一眼看出还有几件没做', async () => {
    serve([entry('m_1', 'a', false), entry('m_2', 'b', false), entry('m_3', 'c', true)]);
    render(<Memo />);

    const meta = await screen.findByText(/待办/);
    expect(meta.textContent).toMatch(/2\s*待办/);
    expect(meta.textContent).toMatch(/1\s*已完成/);
  });

  it('勾选会写回服务端（不只是本地视觉变化）', async () => {
    serve([entry('m_1', '要勾的', false)]);
    render(<Memo />);
    await screen.findByText('要勾的');

    fireEvent.click(screen.getByTitle('标为完成'));

    await waitFor(() => {
      const put = fetchJSON.mock.calls.find((c) => c[1] && (c[1] as { method?: string }).method === 'PUT');
      expect(put).toBeTruthy();
      expect(String(put![0])).toContain('/api/memo/m_1');
      expect((put![1] as { body: { done: boolean } }).body.done).toBe(true);
    });
  });
});
