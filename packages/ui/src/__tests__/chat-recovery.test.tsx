/**
 * 用户报的几件事的判据（不是快照，每条都对应一个用户会注意到的行为）：
 *
 *  1. "重启后有的未完成/被打断的 chat 无法发送消息" —— 发送被上一轮挡住时**必须有回声**，
 *     而且打开会话时若服务端说没在跑，本地状态要自愈（否则那条会话永远发不出去）。
 *  2. "关闭窗口后不会保留窗口内未发送的消息" —— 草稿存在 localStorage，按会话分键。
 *  3. "部分 chat 显示异常" —— 压缩摘要以 user 角色留在历史里，但它是系统产生的，
 *     不能渲染成一团"用户说过的话"。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Chat } from '../components/Chat';
import { normalizeHistory } from '../hooks/useChat';
import { loadDraft, saveDraft, clearDraft, draftKey } from '../lib/draft';
import type { ChatMessage } from '../hooks/useChat';

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

beforeEach(() => {
  localStorage.clear();
});

describe('草稿：关掉窗口也不能丢', () => {
  it('存进去再读回来是同一段文字', () => {
    saveDraft('sess_a', '没发完的一句话');
    expect(loadDraft('sess_a')).toBe('没发完的一句话');
  });

  it('按会话分键 —— 切到别的会话不会串味', () => {
    saveDraft('sess_a', 'A 的草稿');
    saveDraft('sess_b', 'B 的草稿');
    expect(loadDraft('sess_a')).toBe('A 的草稿');
    expect(loadDraft('sess_b')).toBe('B 的草稿');
    expect(loadDraft('sess_c')).toBe('');
  });

  it('空文本等于删除，不留空键', () => {
    saveDraft('sess_a', '有内容');
    saveDraft('sess_a', '');
    expect(loadDraft('sess_a')).toBe('');
  });

  it('没有会话 id 时也有一个位置（不会整段丢掉）', () => {
    saveDraft(null, '还没选会话时写的');
    expect(loadDraft(null)).toBe('还没选会话时写的');
    expect(draftKey(null)).not.toBe(draftKey('sess_a'));
  });

  it('组件重新挂载（等价于关掉窗口再打开）之后，输入框里还是那段草稿', () => {
    const first = render(<Chat {...chatProps({ draftKey: 'sess_keep' })} />);
    const box = first.container.querySelector('textarea') as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    fireEvent.change(box, { target: { value: '写了一半的话' } });
    expect(box.value).toBe('写了一半的话');
    first.unmount();

    const again = render(<Chat {...chatProps({ draftKey: 'sess_keep' })} />);
    const box2 = again.container.querySelector('textarea') as HTMLTextAreaElement;
    expect(box2.value, '关掉窗口后草稿丢了').toBe('写了一半的话');
  });
});

describe('发不出去的时候要说话', () => {
  it('上一轮还在进行 → 提示条出现并给出打断入口', () => {
    const onStop = vi.fn();
    const { container } = render(<Chat {...chatProps({
      isLoading: true, sendBlocked: true, onStop,
      messages: [{ role: 'user', content: '在吗' } as ChatMessage],
    })} />);
    const text = container.textContent ?? '';
    expect(text, '发送被拒绝却什么都没显示').toContain('上一轮还在进行');
    const btn = container.querySelector('[data-surface="run-notice"] button') as HTMLButtonElement;
    expect(btn, '提示条没有给出打断的入口').toBeTruthy();
    btn.click();
    expect(onStop).toHaveBeenCalled();
  });

  it('长命令跑着（isLoading 但没有别的理由）→ 不许冒出提示条', () => {
    /*
     * 用户报「这个提示一直存在，但其实根本不需要」。它会亮，是因为一次工具调用本来就几分钟
     * 没有新帧（长命令、长思考都是），而那正是最常见的路径 —— 在正常路径上就会亮的警告，
     * 只会训练人忽略它。出口没丢：运行中发送键本来就是「停止」。
     */
    const { container } = render(<Chat {...chatProps({
      isLoading: true,
      messages: [{ role: 'user', content: '在吗' } as ChatMessage],
    })} />);
    expect(container.querySelector('[data-surface="run-notice"]'), '长命令跑着时冒出了提示条').toBeNull();
    expect(container.querySelector('button[aria-label="停止"]'), '停止入口不见了').toBeTruthy();
  });

  it('空闲时不显示任何提示条（不能变成常驻噪音）', () => {
    const { container } = render(<Chat {...chatProps({
      messages: [{ role: 'user', content: '在吗' } as ChatMessage],
    })} />);
    expect(container.querySelector('[data-surface="run-notice"]')).toBeNull();
  });
});

describe('历史里的系统产物不能冒充用户消息', () => {
  it('压缩摘要渲染成系统说明，不是用户气泡', () => {
    const out = normalizeHistory([
      { role: 'user', content: '[压缩记录] 本次对话较早的 1078 条记录已经被压缩…' },
      { role: 'user', content: '真正的一句话' },
    ] as never);
    expect(out[0].role, '压缩摘要被渲染成了用户消息').toBe('system');
    expect(out[1].role).toBe('user');
    expect(out[1].content).toBe('真正的一句话');
  });

  it('自动续跑同样是系统说明', () => {
    const out = normalizeHistory([{ role: 'user', content: '[自动续跑] 继续' }] as never);
    expect(out[0].role).toBe('system');
  });

  it('工具结果从配对的调用里取回名字（磁盘上不存 toolName）', () => {
    const out = normalizeHistory([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '{}' } }],
      },
      { role: 'tool', content: '文件内容', tool_call_id: 'c1' },
    ] as never);
    const tool = out.find((m) => m.role === 'tool') as { toolName?: string } | undefined;
    expect(tool?.toolName, '工具名没有从调用里补回来').toBe('fs_read');
  });
});

describe('草稿键', () => {
  it('clearDraft 之后读不到', () => {
    saveDraft('sess_a', 'x');
    clearDraft('sess_a');
    expect(loadDraft('sess_a')).toBe('');
  });
});


/**
 * 「回到最新」必须真的回到最新。
 *
 * 用户报的原话：「现在点击"回到最新"，并不能回到最新的」。根因是平滑滚动 + `content-visibility: auto`
 * 打架：视口外的行按 `contain-intrinsic-size` 估算布局，而平滑动画瞄准的是动画开始那一刻的坐标，
 * 动画过程中行被真实布局、高度变了，于是落短。
 *
 * jsdom 不做排版，所以这里把几何量塞进容器：断言的是**契约**（点完 scrollTop 等于 scrollHeight），
 * 而不是某个实现细节 —— 旧写法在这条判据下会红，因为 scrollIntoView 在 jsdom 里是被桩掉的空操作，
 * scrollTop 会留在 0。
 */
describe('回到最新：点了必须真的落到底', () => {
  it('点击后 scrollTop 落到 scrollHeight', () => {
    const { container } = render(<Chat {...chatProps({
      messages: [
        { role: 'user', content: '在吗' } as ChatMessage,
        { role: 'assistant', content: '在' } as ChatMessage,
      ],
    })} />);

    const scroller = container.querySelector('[data-surface="transcript"]') as HTMLElement;
    expect(scroller, '找不到滚动容器').toBeTruthy();
    Object.defineProperty(scroller, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
    scroller.scrollTop = 0;

    // 先让「不在底部」成立（滚动监听按当前几何量算），按钮才会出现。
    fireEvent.scroll(scroller);
    const btn = container.querySelector('button[title="回到最新"]') as HTMLButtonElement;
    expect(btn, '不在底部时没有给跳转入口').toBeTruthy();

    fireEvent.click(btn);

    expect(scroller.scrollTop, '点了却停在半路（旧写法在 jsdom 下就是 0）').toBe(1200);
    expect(container.querySelector('button[title="回到最新"]'), '落到底之后按钮就该消失').toBeNull();
  });
});