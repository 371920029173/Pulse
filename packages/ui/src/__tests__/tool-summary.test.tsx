/**
 * 工具卡片的摘要行：**表里没有的工具也不许把原始 JSON 摆进记录**。
 *
 * 用户报过"页面用久了有些渲染部件出问题"，其中一半就是这个：errorbook_forget /
 * memo_add / plan_update / schedule_create / skill_read / lsp_* / mcp_call 这些不在
 * 手写摘要表里的工具，摘要回退成 JSON.stringify(args)，记录里就出现
 * `errorbook_forget {"id":"…","reason":"…"}` 这种调试日志一样的行。
 *
 * 另一半（"思维链"标签被压成竖排）是 CSS 的事，判据在 scripts/control-style-check.mjs
 * 里 —— jsdom 没有布局引擎，这条测试管不了它，所以两边分开钉。
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Chat } from '../components/Chat';
import type { ChatMessage } from '../hooks/useChat';

/** 与 render.test.tsx 相同的搭台方式：每个回调都是 spy。 */
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

function callMsg(name: string, args: unknown): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } as ChatMessage;
}

/** 只取工具卡片里的文字（整段记录会包含其它卡片）。 */
function cardText(container: HTMLElement): string {
  return container.querySelector('[data-surface="tool"]')?.textContent ?? '';
}

describe('工具卡片的摘要行', () => {
  it('表里没有的工具：显示参数里那个"目标"，不显示原始 JSON', () => {
    const { container } = render(<Chat {...chatProps({
      messages: [callMsg('errorbook_forget', { id: 'e8653534', reason: '不是我的错' })],
    })} />);
    const text = cardText(container);
    expect(text).toContain('e8653534');
    expect(text, '原始 JSON 又漏进记录了').not.toContain('{"id"');
    expect(text, '原始 JSON 又漏进记录了').not.toContain('"reason"');
  });

  it('MCP 调用显示成 服务器 / 工具', () => {
    const { container } = render(<Chat {...chatProps({
      messages: [callMsg('mcp_call', { server: 'filesystem', tool: 'read_file' })],
    })} />);
    const text = cardText(container);
    expect(text).toContain('filesystem');
    expect(text).toContain('read_file');
    expect(text).not.toContain('{"server"');
  });

  it('参数形状完全不认识时仍退回 JSON —— 调试信息不能一起丢掉', () => {
    const { container } = render(<Chat {...chatProps({
      messages: [callMsg('some_future_tool', { foo: 1 })],
    })} />);
    expect(cardText(container)).toContain('{"foo"');
  });

  it('没有参数的工具不显示空 JSON', () => {
    const { container } = render(<Chat {...chatProps({
      messages: [callMsg('shell_jobs', {})],
    })} />);
    expect(cardText(container)).not.toContain('{}');
  });

  it('本来就手写了摘要的工具不受影响（回归）', () => {
    const { container } = render(<Chat {...chatProps({
      messages: [callMsg('fs_read', { path: 'packages/ui/src/App.tsx' })],
    })} />);
    expect(cardText(container)).toContain('packages/ui/src/App.tsx');
  });
});
