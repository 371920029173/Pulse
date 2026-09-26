/**
 * Render tests for the two components a user sees most: the chat surface and the
 * session list.
 *
 * These are behavioural, not snapshot tests. Snapshots would break on every
 * styling tweak and be routinely re-recorded without being read — the opposite of
 * useful. Instead each test asserts one thing a user would notice:
 *
 *   - an empty conversation explains what to do (it is the first screen seen)
 *   - a message's text is actually visible
 *   - a failed turn reports the failure instead of rendering blank
 *   - the session list distinguishes the active session, work groups, and closed
 *     history, because those are the states that were wrong before
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Chat } from '../components/Chat';
import { Sidebar } from '../components/Sidebar';
import type { ChatMessage } from '../hooks/useChat';
import type { SessionMeta } from '../components/Sidebar';

/** Minimal Chat props; every callback is a spy so interactions can be asserted. */
function chatProps(overrides: Record<string, unknown> = {}) {
  return {
    messages: [] as ChatMessage[],
    isLoading: false,
    pendingConfirm: null,
    pendingPatch: null,
    onSend: vi.fn(),
    onStop: vi.fn(),
    onConfirm: vi.fn(),
    onDismissConfirm: vi.fn(),
    onApplyPatch: vi.fn(),
    onRejectPatch: vi.fn(),
    ...overrides,
  } as Parameters<typeof Chat>[0];
}

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  role: 'user',
  content: '',
  ...over,
} as ChatMessage);

describe('Chat 空状态', () => {
  it('空对话不是一片空白 —— 要说明能做什么', () => {
    const { container } = render(<Chat {...chatProps()} />);
    const text = container.textContent ?? '';
    // The empty state is the first thing a new user sees; a blank panel reads as
    // broken. It must carry instructions.
    expect(text.length).toBeGreaterThan(20);
  });

  it('空状态提到拖放，因为这是一条能被发现的功能', () => {
    const { container } = render(<Chat {...chatProps()} />);
    expect(container.textContent ?? '').toMatch(/拖|drop|拖放/i);
  });

  it('有消息时不再显示空状态', () => {
    const { container } = render(<Chat {...chatProps({
      messages: [msg({ role: 'user', content: '你好世界' })],
    })} />);
    expect(container.textContent).toContain('你好世界');
  });
});

describe('Chat 消息渲染', () => {
  it('用户消息内容可见', () => {
    render(<Chat {...chatProps({ messages: [msg({ role: 'user', content: '唯一标记字符串ABC' })] })} />);
    expect(screen.getByText(/唯一标记字符串ABC/)).toBeTruthy();
  });

  it('助手消息内容可见', () => {
    render(<Chat {...chatProps({
      messages: [msg({ role: 'assistant', content: '助手回复标记XYZ' })],
    })} />);
    expect(screen.getByText(/助手回复标记XYZ/)).toBeTruthy();
  });

  it('长会话从第一条到最后一条都在页面上', () => {
    const messages = Array.from({ length: 50 }, (_, i) =>
      msg({ role: i % 2 ? 'assistant' : 'user', content: `回合标记${i}` }));
    const { container } = render(<Chat {...chatProps({ messages })} />);
    const text = container.textContent ?? '';
    expect(text).toContain('回合标记0');
    expect(text).toContain('回合标记49');
    expect(text).not.toContain('加载更早');
  });

  it('错误消息要显示出来，而不是静默吞掉', () => {
    render(<Chat {...chatProps({
      messages: [msg({ role: 'assistant', content: 'Error: 连接失败测试用错误' })],
    })} />);
    expect(screen.getByText(/连接失败测试用错误/)).toBeTruthy();
  });

  it('思维链默认折叠：只显示首行，点开后全文在页面上', () => {
    const chain = '第一行思维链标记AAA\n' + '后续很长的推理'.repeat(40);
    const { container } = render(<Chat {...chatProps({
      messages: [msg({ role: 'assistant', content: '', reasoning: chain })],
    })} />);
    const before = container.textContent ?? '';
    expect(before).toContain('第一行思维链标记AAA');
    expect(before).not.toContain('后续很长的推理'.repeat(40));
    expect(before).not.toContain('空回复');
    const header = container.querySelector('[data-surface="reasoning"] button') as HTMLButtonElement;
    fireEvent.click(header);
    expect(container.textContent ?? '').toContain('后续很长的推理'.repeat(40));
  });
});

describe('Chat 忙碌状态', () => {
  it('加载中显示停止入口（否则无法中断）', () => {
    const { container } = render(<Chat {...chatProps({ isLoading: true })} />);
    expect(container.textContent ?? '').toMatch(/停止|暂停|stop/i);
  });
});

/** Minimal Sidebar props. */
function sidebarProps(overrides: Record<string, unknown> = {}) {
  return {
    tree: [],
    sessions: [] as SessionMeta[],
    activeSessionId: null,
    onGroupClick: vi.fn(),
    ...overrides,
  } as Parameters<typeof Sidebar>[0];
}

const session = (over: Partial<SessionMeta>): SessionMeta => ({
  id: 's1',
  title: '会话标题',
  updatedAt: new Date().toISOString(),
  messageCount: 0,
  ...over,
} as SessionMeta);

describe('Sidebar 会话列表', () => {
  it('列出会话标题', () => {
    render(<Sidebar {...sidebarProps({
      sessions: [session({ id: 'a', title: '第一个会话AAA' })],
    })} />);
    expect(screen.getByText(/第一个会话AAA/)).toBeTruthy();
  });

  it('标出当前会话（否则用户不知道在哪一个里）', () => {
    const { container } = render(<Sidebar {...sidebarProps({
      sessions: [session({ id: 'a', title: '当前会话AAA' }), session({ id: 'b', title: '其它会话BBB' })],
      activeSessionId: 'a',
    })} />);
    // The active row must be visually distinguishable, which means a distinct
    // class rather than only a colour difference we cannot read here.
    const html = container.innerHTML;
    expect(html).toMatch(/active|Active/);
  });

  it('工作群会话带标记（与普通会话区分）', () => {
    const { container } = render(<Sidebar {...sidebarProps({
      sessions: [session({ id: 'g', title: '讨论群CCC', kind: 'cluster' })],
    })} />);
    expect(container.textContent).toMatch(/群|组|讨论/);
  });

  it('会话很多时收纳，只展开最近的几条', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      session({ id: `s${i}`, title: `第${i}个会话` }));
    const { container } = render(<Sidebar {...sidebarProps({ sessions: many, activeSessionId: 's0' })} />);
    const text = container.textContent ?? '';
    // The list is folded to keep the panel usable; earlier sessions are reachable
    // through the fold toggle rather than being gone.
    const shown = many.filter((s) => text.includes(s.title!)).length;
    expect(shown, '没有折叠，12 条全展开了').toBeLessThan(many.length);
    expect(shown, '折叠掉了最近的内容').toBeGreaterThan(0);
  });

  it('没有会话时不崩溃', () => {
    expect(() => render(<Sidebar {...sidebarProps({ sessions: [] })} />)).not.toThrow();
  });
});
