/**
 * The parallel-working-copies panel.
 *
 * The API for worktrees already existed and the command palette already created them; what was
 * missing was any screen that listed them. So the assertions here are about the three things a
 * LIST of directories has to get right, each of which was a real gap or a real hazard:
 *
 *   1. **The full path is shown.** It is the only handle the user has outside this window —
 *      `.she-worktrees/<repo>/<name>` is not reconstructable from memory, and it is what a terminal
 *      or an editor needs.
 *   2. **The main checkout is labelled and cannot be deleted.** `git worktree list` returns it like
 *      any other entry, so an unlabelled list offers a destructive button on the one directory that
 *      must not be removed. The separator normalisation is tested too, because git reports forward
 *      slashes on Windows while the settings path is native — with a raw `===` the label silently
 *      never appears.
 *   3. **A refusal is reported on the row that was refused.** `git worktree remove` without
 *      `--force` refuses a directory holding uncommitted work, which is exactly the directory a user
 *      is about to lose. A generic toast would say "failed" and lose git's own explanation.
 *
 * `fetchJSON` is mocked rather than a server started: these are properties of the view, and the
 * route itself is covered by the server's own worktree tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const fetchJSON = vi.fn();
vi.mock('../lib/api', () => ({ fetchJSON: (...args: unknown[]) => fetchJSON(...args) }));

const { WorktreePanel } = await import('../components/WorktreePanel');

// portability-check:allow — 面板要做的正是「把以盘符开头的绝对路径显示成人看得懂的样子」，
// 所以夹具必须是盘符路径；换成 path.join 就测不到那个分支了。
const MAIN = 'D:\\AGI\\she-agent-cloud';
const COPY = 'D:\\AGI\\.she-worktrees\\she-agent-cloud\\feature-a';

const list = (worktrees: unknown[]) => ({ repo: MAIN, worktrees });

describe('WorktreePanel', () => {
  beforeEach(() => {
    fetchJSON.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('列出每个副本的完整路径和分支（否则用户出了这个窗口就找不到它）', async () => {
    fetchJSON.mockResolvedValue(list([
      { path: MAIN, head: 'a'.repeat(40), branch: 'main' },
      { path: COPY, head: 'b'.repeat(40), branch: 'she/feature-a' },
    ]));

    render(<WorktreePanel onClose={vi.fn()} repo={MAIN} />);

    expect(await screen.findByText('she/feature-a')).toBeTruthy();
    // The path, not just the last segment: the whole point is that it is usable elsewhere.
    expect(screen.getByText(COPY)).toBeTruthy();
    expect(screen.getByText(MAIN)).toBeTruthy();
  });

  it('【关键】标出主仓库，并且不允许删除它', async () => {
    fetchJSON.mockResolvedValue(list([
      { path: MAIN, head: 'a'.repeat(40), branch: 'main' },
      { path: COPY, head: 'b'.repeat(40), branch: 'she/feature-a' },
    ]));

    render(<WorktreePanel onClose={vi.fn()} repo={MAIN} />);

    const mainBadge = await screen.findByText('主仓库');
    const row = mainBadge.closest('li')!;
    const deleteButton = [...row.querySelectorAll('button')].find((b) => b.textContent === '删除')!;

    // The badge and the guard are two separate facts, so both are asserted: a label without the
    // guard still lets the click through.
    expect(deleteButton).toBeTruthy();
    expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('主仓库的识别容忍 git 用正斜杠、配置用反斜杠', async () => {
    // On Windows `git worktree list` prints `D:/AGI/...`, so a raw comparison never matches and the
    // badge would never render — the failure looks like nothing at all.
    fetchJSON.mockResolvedValue(list([
      { path: MAIN.replace(/\\/g, '/'), head: 'a'.repeat(40), branch: 'main' },
    ]));

    render(<WorktreePanel onClose={vi.fn()} repo={MAIN} />);

    expect(await screen.findByText('主仓库')).toBeTruthy();
  });

  it('【关键】删除被 git 拒绝时，理由留在那一行上', async () => {
    fetchJSON.mockImplementation(async (_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'DELETE') {
        // portability-check:allow — git 的原文错误信息就是长这样的，夹具得照抄才测得准。
        throw new Error("fatal: 'D:\\AGI\\.she-worktrees\\...' contains modified or untracked files, use --force to delete it");
      }
      return list([{ path: COPY, head: 'b'.repeat(40), branch: 'she/feature-a' }]);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<WorktreePanel onClose={vi.fn()} repo={MAIN} />);

    const deleteButton = await screen.findByText('删除');
    fireEvent.click(deleteButton);

    // `use --force` is the part the user has to see: it says the directory still has work in it.
    await waitFor(() => expect(screen.getByText(/use --force/)).toBeTruthy());
  });

  it('删除前确认，且确认文案里带上目录', async () => {
    fetchJSON.mockResolvedValue(list([{ path: COPY, head: 'b'.repeat(40), branch: 'she/feature-a' }]));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<WorktreePanel onClose={vi.fn()} repo={MAIN} />);

    fireEvent.click(await screen.findByText('删除'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // Naming the directory is what makes the question answerable when several copies are open.
    expect(String(confirmSpy.mock.calls[0][0])).toContain(COPY);
    // Declined: no request is sent.
    expect(fetchJSON.mock.calls.every((c) => (c[1] as { method?: string } | undefined)?.method !== 'DELETE')).toBe(true);
  });

  it('没有副本时说明副本是什么，而不是只显示空列表', async () => {
    fetchJSON.mockResolvedValue(list([]));
    render(<WorktreePanel onClose={vi.fn()} repo={MAIN} />);
    expect(await screen.findByText('还没有并行工作副本')).toBeTruthy();
    // The hint has to explain the mechanism, because "worktree" is not self-explanatory.
    expect(screen.getByText(/she\/<名字>/)).toBeTruthy();
  });
});
