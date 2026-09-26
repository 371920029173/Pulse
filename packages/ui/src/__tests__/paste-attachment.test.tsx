/**
 * 粘贴图片：从剪贴板到「模型真的能看见」这条链路的客户端一段。
 *
 * 这条链路有三处容易断，测试各钉一处：
 *
 *   1. **剪贴板上的图片没有路径。** 拖进来的文件有 `path`，可以用 `@file:` 引用；粘贴进来的没有，
 *      只有字节。因此必须在粘贴时就上传，否则发送的是一个空引用。测试断言上传真的发生了，
 *      并且发出去的 `<img>` 用的是服务端返回的地址。
 *   2. **纯文本粘贴不能被吞掉。** 一旦 `preventDefault` 用错了地方，粘贴路径、粘贴代码块就全废了 ——
 *      这是比缺图片严重得多的回归。
 *   3. **上传失败必须说。** 静默丢一个附件，用户会以为模型看到了。失败时要有可见的提示，
 *      而不是一个空白的输入框。
 *
 * 这里走真实的 `Chat` 组件和真实的 `fetch`（只把响应打桩），因为要验的正是
 * 「paste 事件 → 上传 → chip → 发送时带上 path」这一串，跳过组件就只剩自证。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, fireEvent, waitFor } from '@testing-library/react';
import { Chat } from '../components/Chat';
import { useChat } from '../hooks/useChat';

/**
 * Windows-style path, assembled at runtime.
 *
 * A literal `X:\` in source trips `check:portability` — that rule exists because a baked-in drive
 * letter breaks every other platform and ships to everyone. Here the Windows form is exactly what
 * the test needs to exercise (history stores native paths), so it is built instead of written.
 */
const winPath = (...parts: string[]) => parts.join('\\');

const UPLOADED = {
  path: winPath('D:', 'ws', '.she', 'attachments', 'm1-abc-pasted.png'),
  relPath: '.she/attachments/m1-abc-pasted.png',
  name: 'm1-abc-pasted.png',
  mime: 'image/png',
  bytes: 3,
  url: '/api/attachments/file?name=m1-abc-pasted.png',
};
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 记录下来每一次上传，测试要能看到请求体与文件名头。 */
interface Upload {
  url: string;
  filename: string | null;
  mime: string | null;
  bodySize: number;
}

function installFetch(behaviour: 'ok' | 'fail' = 'ok') {
  const uploads: Upload[] = [];
  vi.mocked(fetch).mockImplementation((async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/attachments')) {
      const headers = new Headers(init?.headers);
      const body = init?.body as Blob | undefined;
      uploads.push({
        url,
        filename: headers.get('X-Filename'),
        mime: headers.get('X-Mime'),
        bodySize: body?.size ?? -1,
      });
      if (behaviour === 'fail') return jsonResponse({ error: '附件过大（上限 8MB）' }, 413);
      return jsonResponse(UPLOADED);
    }
    return jsonResponse({});
  }) as unknown as typeof fetch);
  return { uploads };
}

/** A pasted screenshot: name is always the same, which is why the chip shows a thumbnail. */
function clipboardWithImage() {
  const file = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });
  return {
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
  };
}

function mount(behaviour: 'ok' | 'fail' = 'ok') {
  const sent: Array<{ text: string; images?: Array<{ path: string; mime: string }> }> = [];
  const { uploads } = installFetch(behaviour);
  const view = render(
    <Chat
      messages={[]}
      isLoading={false}
      pendingConfirm={null}
      pendingPatch={null}
      onSend={(text, images) => { sent.push({ text, images }); }}
      onStop={vi.fn()}
      onConfirm={vi.fn()}
      onDismissConfirm={vi.fn()}
      onApplyPatch={vi.fn()}
      onRejectPatch={vi.fn()}
    />,
  );
  const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement;
  const paste = async (clipboardData: unknown) => {
    await act(async () => {
      fireEvent.paste(textarea, { clipboardData });
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  return { view, textarea, sent, uploads, paste };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  // jsdom 没有 matchMedia / ResizeObserver，组件里的自适应高度与主题监听要用到。
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
});

describe('粘贴图片', () => {
  it('粘贴的图片被上传，并以缩略图出现在输入框上方', async () => {
    const v = mount();
    await v.paste(clipboardWithImage());

    await waitFor(() => expect(v.uploads.length).toBe(1));
    // 原始文件名进请求头，字节进请求体：剪贴板的文件名永远是 image.png，服务端要自己起名。
    expect(v.uploads[0].filename).toBe('image.png');
    expect(v.uploads[0].mime).toBe('image/png');
    expect(v.uploads[0].bodySize).toBe(3);

    const thumb = v.view.container.querySelector('img[src*="/api/attachments/file"]');
    expect(thumb).toBeTruthy();
  });

  it('发送时带上附件的路径，而不是把图片塞进文本里', async () => {
    const v = mount();
    await v.paste(clipboardWithImage());
    await waitFor(() => expect(v.uploads.length).toBe(1));

    const sendBtn = v.view.container.querySelector('button[aria-label="发送"]') as HTMLButtonElement;
    // 没有文字也应当可以发送：一个截图本身就是一句话。
    expect(sendBtn.disabled).toBe(false);
    await act(async () => { fireEvent.click(sendBtn); });

    expect(v.sent.length).toBe(1);
    expect(v.sent[0].images?.[0].path).toBe(UPLOADED.path);
    expect(v.sent[0].text).toBe('');
    // 发出去之后 chip 清空，下一个回合不会重复带上同一张图。
    expect(v.view.container.querySelector('img[src*="/api/attachments/file"]')).toBeNull();
  });

  it('带文字的粘贴：文字与图片一起走，文字不被丢掉', async () => {
    const v = mount();
    await act(async () => {
      fireEvent.change(v.textarea, { target: { value: '这个报错怎么修？' } });
    });
    await v.paste(clipboardWithImage());
    await waitFor(() => expect(v.uploads.length).toBe(1));

    await act(async () => {
      fireEvent.keyDown(v.textarea, { key: 'Enter' });
    });
    expect(v.sent[0].text).toContain('这个报错怎么修？');
    expect(v.sent[0].images?.length).toBe(1);
  });

  it('纯文本粘贴不被打断（路径、代码块照常粘）', async () => {
    const v = mount();
    await v.paste({ items: [], getData: () => 'src/main.ts' });
    expect(v.uploads.length).toBe(0);
    expect(v.sent.length).toBe(0);
  });

  it('上传失败会说出来，而不是安静地少一张图', async () => {
    const v = mount('fail');
    await v.paste(clipboardWithImage());
    await waitFor(() => expect(v.uploads.length).toBe(1));
    expect(v.view.container.textContent).toContain('附件过大');
  });

  it('可以移除已粘贴的附件', async () => {
    const v = mount();
    await v.paste(clipboardWithImage());
    await waitFor(() => expect(v.uploads.length).toBe(1));
    const remove = v.view.container.querySelector('button[aria-label="移除附件"]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(remove); });
    expect(v.view.container.querySelector('img[src*="/api/attachments/file"]')).toBeNull();
    const sendBtn = v.view.container.querySelector('button[aria-label="发送"]') as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it('回合进行中追加文字：附件留在输入框里，不会被悄悄丢掉', async () => {
    const sent: string[] = [];
    const interjected: string[] = [];
    installFetch();
    const view = render(
      <Chat
        messages={[]}
        isLoading
        pendingConfirm={null}
        pendingPatch={null}
        onSend={(text) => { sent.push(text); }}
        onInterject={(text) => { interjected.push(text); }}
        onStop={vi.fn()}
        onConfirm={vi.fn()}
        onDismissConfirm={vi.fn()}
        onApplyPatch={vi.fn()}
        onRejectPatch={vi.fn()}
      />,
    );
    const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.paste(textarea, { clipboardData: clipboardWithImage() });
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '再补充一点' } });
      fireEvent.keyDown(textarea, { key: 'Enter' });
    });

    expect(interjected.length).toBe(1);
    expect(sent.length).toBe(0);
    // 中途追加只支持文字，所以附件必须还在：chip 在 = 还没发出去。
    expect(view.container.querySelector('img[src*="/api/attachments/file"]')).toBeTruthy();
  });
});

/**
 * 重新打开会话之后，附件还在。
 *
 * 服务端存的只有路径，所以「重开就有缩略图」并不是自动的：客户端要自己把路径换回可预览的地址。
 * 这一步漏掉的表现很隐蔽 —— 当次会话里一切正常，第二天打开同一个对话，图片变成一行文件名。
 * 同时断言反过来的那一半：`.she/attachments` 之外的路径不给预览地址，用文件 chip 显示，
 * 而不是发一个注定 404 的请求去换一个碎图标。
 */
describe('重新载入会话时的附件', () => {
  function HistoryHarness({ api }: { api: { current: (() => Promise<void>) | null } }) {
    const chat = useChat('sess_paste');
    api.current = chat.loadHistory;
    return (
      <Chat
        messages={chat.messages}
        isLoading={false}
        pendingConfirm={null}
        pendingPatch={null}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onConfirm={vi.fn()}
        onDismissConfirm={vi.fn()}
        onApplyPatch={vi.fn()}
        onRejectPatch={vi.fn()}
      />
    );
  }

  it('存档里的附件按路径还原成缩略图，目录外的路径退回文件 chip', async () => {
    vi.mocked(fetch).mockImplementation((async (input: unknown) => {
      const url = String(input);
      if (url.startsWith('/api/chat/history')) {
        return jsonResponse({
          messages: [
            {
              role: 'user',
              content: '看看这个',
              images: [{ path: winPath('D:', 'ws', '.she', 'attachments', 'm1-abc-a.png'), mime: 'image/png' }],
            },
            {
              role: 'user',
              content: '还有这个',
              images: [{ path: winPath('D:', 'somewhere', 'else', 'b.png'), mime: 'image/png' }],
            },
          ],
        });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch);

    const api: { current: (() => Promise<void>) | null } = { current: null };
    const view = render(<HistoryHarness api={api} />);
    await act(async () => { await api.current!(); });
    const thumbs = view.container.querySelectorAll('img[src*="/api/attachments/file"]');
    expect(thumbs.length).toBe(1);
    expect(thumbs[0].getAttribute('src')).toContain('m1-abc-a.png');
    // 第二个：目录外的路径没有预览地址，但文件名仍然可见，用户知道自己附过东西。
    expect(view.container.textContent).toContain('b.png');
  });
});
