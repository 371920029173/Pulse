/**
 * Test setup.
 *
 * jsdom implements the DOM but not the browser APIs this app depends on, so the
 * ones it actually uses are stubbed here. Each stub is deliberately minimal: it
 * exists so a component can render, not to simulate a browser faithfully.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom has no layout engine, so these are absent. Components call them for
// measurements during render.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// Range is used by the scroll-follow logic in the chat view.
if (!document.createRange) {
  document.createRange = (() => ({
    setStart: () => {},
    setEnd: () => {},
    commonAncestorContainer: document.body,
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
  })) as unknown as typeof document.createRange;
}

/**
 * A network call out of a unit test is a bug, so `fetch` must never reach out.
 *
 * This is installed per test, NOT once at module load. The runner is configured
 * with `restoreMocks: true`, which restores globals that `vi.stubGlobal` replaced
 * — a stub installed at load time is silently undone before the first test, and
 * the components then issue REAL requests against whatever is listening on the
 * API port.
 *
 * The rejection is deferred rather than immediate. Several components fetch in a
 * fire-and-forget `useEffect`; rejecting straight away makes them set state after
 * the test has finished, which React reports as an unwrapped-`act` warning. That
 * warning describes the harness, not the product, and noise in test output trains
 * people to ignore it. Deferring past unmount keeps the output clean, while an
 * unexpected call is still visible via `vi.mocked(fetch).mock.calls`.
 */
const pendingFetches: Array<() => void> = [];

beforeEach(() => {
  pendingFetches.length = 0;
  vi.stubGlobal('fetch', vi.fn(() => new Promise((_resolve, reject) => {
    pendingFetches.push(() => reject(new Error('测试中出现了未 mock 的 fetch 调用')));
  })));
});

/*
 * Teardown order matters and is easy to get wrong: the deferred rejections must
 * fire AFTER unmount. Two separate `afterEach` hooks made the order depend on the
 * runner's hook ordering, and when the rejection won the race the components were
 * still mounted, so their state update showed up as an unwrapped-`act` warning.
 * One hook with explicit sequencing removes the ambiguity.
 */
afterEach(() => {
  cleanup();
  for (const reject of pendingFetches.splice(0)) reject();
});
