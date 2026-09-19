/**
 * Accessibility (UI).
 *
 * Not a full audit — no contrast measurement, no screen-reader testing. These are the
 * failures that are structural and therefore checkable, and that this codebase
 * actually had:
 *
 *   1. A control built from a `<div>` with `onClick`. It is not reachable by Tab, not
 *      announced as interactive, and not operable with Enter or Space. The visual
 *      affordance is identical, which is why it survives review.
 *   2. A dialog with no keyboard dismissal. Clicking the backdrop works; a keyboard
 *      user who opens Settings is stuck.
 *   3. An icon-only control with no accessible name, which a screen reader announces
 *      as "button".
 *
 * The Escape test drives the real hook rather than inspecting source, because the
 * behaviour depends on event ordering that source inspection cannot confirm.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

describe('useEscapeToClose', () => {
  it('Escape 调用关闭回调', () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeToClose(onClose));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('其他按键不触发', () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeToClose(onClose));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('enabled 为 false 时不响应（例如保存中）', () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeToClose(onClose, false));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('卸载后不再响应（不泄漏监听器）', () => {
    const onClose = vi.fn();
    const { unmount } = renderHook(() => useEscapeToClose(onClose));
    unmount();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('没有回调时不报错', () => {
    renderHook(() => useEscapeToClose(undefined));
    expect(() => {
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    }).not.toThrow();
  });

  it('【关键】嵌套弹窗时只有最上层的关闭', () => {
    // Opening a confirmation inside a panel must not dismiss both at once, which is
    // what a naive implementation does.
    const outer = vi.fn();
    const inner = vi.fn();
    const a = renderHook(() => useEscapeToClose(outer, true));
    const b = renderHook(() => useEscapeToClose(inner, true));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer, '外层不该被一起关掉').not.toHaveBeenCalled();

    // With the top one unmounted, Escape reaches the one underneath.
    b.unmount();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(outer).toHaveBeenCalledTimes(1);
    a.unmount();
  });

  it('事件已被更近的处理者消费时不重复处理', () => {
    const onClose = vi.fn();
    renderHook(() => useEscapeToClose(onClose));
    act(() => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      e.preventDefault();
      document.dispatchEvent(e);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('回调变化后使用最新的那个', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }) => useEscapeToClose(cb), {
      initialProps: { cb: first },
    });
    rerender({ cb: second });
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
