/**
 * Guards the test harness itself.
 *
 * These exist because the harness failed in ways that were invisible:
 *
 *  1. The `fetch` stub was installed once at module load, but the runner is
 *     configured with `restoreMocks: true`, which undoes `vi.stubGlobal`. Every
 *     component test was silently issuing REAL HTTP requests to whatever happened
 *     to be listening on the API port — slow, non-deterministic, and dependent on
 *     a developer's running server.
 *  2. Teardown ran in an order that let a deferred rejection set state while
 *     components were still mounted, producing `act` warnings that looked like a
 *     product bug.
 *
 * A broken harness makes every other test untrustworthy, so it gets its own
 * assertions. If these fail, ignore the rest of the suite until they pass.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useEffect, useState } from 'react';

describe('测试环境自身', () => {
  it('fetch 默认是 mock（否则测试会真的发网络请求）', () => {
    expect(vi.isMockFunction(fetch), 'fetch 没有被替换 —— restoreMocks 可能撤销了桩').toBe(true);
  });

  it('未 mock 的 fetch 不会在测试进行中就完成', async () => {
    let settled = false;
    void fetch('/api/should-not-escape').then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(settled, 'fetch 立刻返回了，说明请求真的发出去了').toBe(false);
  });

  it('jsdom 缺少的浏览器 API 已补齐', () => {
    expect(typeof window.matchMedia).toBe('function');
    expect(typeof window.ResizeObserver).toBe('function');
    expect(typeof Element.prototype.scrollIntoView).toBe('function');
  });

  it('组件卸载后异步 setState 不再产生 act 警告', async () => {
    // Reproduces the shape that produced the warning: a fire-and-forget effect
    // whose rejection lands later.
    const warnings: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { warnings.push(String(args[0])); };

    function Later() {
      const [n, setN] = useState(0);
      useEffect(() => {
        const t = setTimeout(() => setN(1), 10);
        return () => clearTimeout(t);
      }, []);
      return <span data-testid="n">{n}</span>;
    }

    const { unmount } = render(<Later />);
    unmount();
    await new Promise((r) => setTimeout(r, 40));

    console.error = original;
    expect(warnings.filter((w) => /act\(/.test(w))).toEqual([]);
  });
});
