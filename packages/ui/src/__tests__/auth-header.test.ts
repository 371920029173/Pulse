/**
 * 本地鉴权头。
 *
 * 服务器那边的边界由 `scripts/tenant-boundary-check.mjs` 钉住；这里钉的是客户端这三件容易漏的事：
 *
 *   1. **令牌真的发出去了。** 服务端开了令牌，客户端不发头 → 每次请求 401，界面表现为「列表是空的」，
 *      而原因看不出。三种运行方式的取法（桌面壳注入、页面全局、浏览器里手填）要有明确的优先级。
 *   2. **没令牌时不要凭空造一个头。** 给未开启鉴权的服务端发一个空令牌是无害的，但给一个开着鉴权
 *      的服务端发「空字符串令牌」会让人以为自己在发令牌，所以宁可不发。
 *   3. **401 要说人话。** 服务端返回的就是 `Unauthorized` 三个字，读起来像 bug 而不像设置项；
 *      唯一有用的信息是「令牌从哪来」。
 *
 * 还有一处是回归性质的：`theme` / `background` / 导出这些直接 `fetch` 的调用点，在鉴权开启后
 * 会各自 401 —— 于是「开了鉴权」等于「样式面板坏了」。它们统一走 `apiFetch`，这里也一并断言。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { fetchJSON, apiFetch, authToken } = await import('../lib/api');

const TOKEN = 'unit-test-token-0123456789';

/** A `fetch` that answers with a JSON body. */
function stubFetch(body: unknown = { ok: true }, status = 200) {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

/**
 * The rejection reason as an `Error`.
 *
 * `fetchJSON` resolves to `unknown`, so `promise.catch((e: Error) => e)` types as `unknown | Error`,
 * which is just `unknown` — and reading `.message` off it is a type error that `tsc -b` refuses
 * (`TS18046`). Awaiting inside a `try` keeps the narrowing on our side of the boundary.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error('期望被拒绝，但它成功了');
}

/**
 * The headers of the Nth fetch call.
 *
 * Returned as a `Headers` rather than a plain object on purpose: `Headers` lower-cases names, so
 * asserting on an object built from it would silently look for `X-SHE-Token` in a map that stores
 * `x-she-token` — a test that fails for a spelling reason rather than a behaviour one. `get()` is
 * case-insensitive by spec, which is also how the server reads it.
 */
function headersOf(mock: ReturnType<typeof vi.fn>, call = 0): Headers {
  const init = mock.mock.calls[call]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers ?? {});
}

describe('令牌的来源优先级', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).sheDesktop;
    delete (globalThis as Record<string, unknown>).__sheAuthToken;
    try { globalThis.localStorage?.clear(); } catch { /* no storage in this environment */ }
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('什么都没有时返回 null，而不是空字符串', () => {
    expect(authToken()).toBe(null);
  });

  it('桌面壳注入的令牌优先 —— 它是在第一次请求之前就就绪的那个', () => {
    (globalThis as Record<string, unknown>).sheDesktop = { authToken: TOKEN };
    (globalThis as Record<string, unknown>).__sheAuthToken = 'weaker-source';
    expect(authToken()).toBe(TOKEN);
  });

  it('没有桌面壳时用页面全局', () => {
    (globalThis as Record<string, unknown>).__sheAuthToken = TOKEN;
    expect(authToken()).toBe(TOKEN);
  });

  it('再退到浏览器里手填的那个', () => {
    globalThis.localStorage.setItem('she.authToken', TOKEN);
    expect(authToken()).toBe(TOKEN);
  });

  it('空白值不算令牌（否则会发出一个空的鉴权头）', () => {
    (globalThis as Record<string, unknown>).sheDesktop = { authToken: '   ' };
    globalThis.localStorage.setItem('she.authToken', '  ');
    expect(authToken()).toBe(null);
  });
});

describe('请求头', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).sheDesktop;
    delete (globalThis as Record<string, unknown>).__sheAuthToken;
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('有令牌时 fetchJSON 带上 X-SHE-Token', async () => {
    (globalThis as Record<string, unknown>).sheDesktop = { authToken: TOKEN };
    const mock = stubFetch({ sessions: [] });
    await fetchJSON('/api/sessions');
    expect(headersOf(mock).get('X-SHE-Token')).toBe(TOKEN);
  });

  it('【关键】没有令牌时不发这个头（不要让人觉得令牌在起作用）', async () => {
    const mock = stubFetch({ sessions: [] });
    await fetchJSON('/api/sessions');
    expect(headersOf(mock).has('X-SHE-Token')).toBe(false);
  });

  it('POST 同时保留 Content-Type', async () => {
    (globalThis as Record<string, unknown>).sheDesktop = { authToken: TOKEN };
    const mock = stubFetch({ ok: true });
    await fetchJSON('/api/config/rollback', { method: 'POST', body: {} });
    const h = headersOf(mock);
    expect(h.get('X-SHE-Token')).toBe(TOKEN);
    expect(h.get('Content-Type')).toBe('application/json');
  });

  it('【关键】apiFetch 也带令牌 —— theme / background / 导出走的就是它', async () => {
    (globalThis as Record<string, unknown>).sheDesktop = { authToken: TOKEN };
    const mock = stubFetch({ enabled: false });
    await apiFetch('/api/theme/disable', { method: 'POST' });
    expect(headersOf(mock).get('X-SHE-Token')).toBe(TOKEN);
  });

  it('apiFetch 不会覆盖调用点自己设的头', async () => {
    (globalThis as Record<string, unknown>).sheDesktop = { authToken: TOKEN };
    const mock = stubFetch({});
    await apiFetch('/api/theme', { headers: { 'X-Custom': 'keep-me' } });
    const h = headersOf(mock);
    expect(h.get('X-Custom')).toBe('keep-me');
    expect(h.get('X-SHE-Token')).toBe(TOKEN);
  });
});

describe('401 的说明', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).sheDesktop;
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('【关键】401 报的是「令牌从哪来」，而不是把 Unauthorized 甩给用户', async () => {
    stubFetch({ error: 'Unauthorized' }, 401);
    await expect(fetchJSON('/api/sessions')).rejects.toThrow(/SHE_AUTH_TOKEN/);
  });

  it('说清令牌怎么给：浏览器没有填令牌的入口，读的是 localStorage', async () => {
    stubFetch({ error: 'Unauthorized' }, 401);
    /*
     * 旧文案让人「在本机填入同一个令牌」，而界面上并没有填凭据的地方 —— 那是一条照着做也做不到的
     * 指示。现在点名真实机制。这条断言存在的意义就是别再退回一句做不到的话。
     */
    await expect(fetchJSON('/api/sessions')).rejects.toThrow(/localStorage/);
  });

  it('【关键】服务端说了具体的话就用它说的，不拿本地那句盖掉（R7 实测：控制面 401 被答成租户开关）', async () => {
    /*
     * 第七轮实测：浏览器直接开 5577（没有控制面凭据）时，服务端的 401 体说的是控制面凭据与它的路径，
     * 而界面横幅让人去设 `SHE_AUTH_TOKEN` —— 一个当时根本没开的开关。
     *
     * 服务端说得比客户端准（它知道是哪一道门拒的），所以客户端不该抢答。
     */
    const body = 'Unauthorized：控制面需要凭据（改运行档位 / 工作区 / 配置的接口）。凭据在 C:\\Users\\x\\.she-app\\control-token，桌面端会自动带上。';
    stubFetch({ error: body }, 401);
    const err = await rejection(fetchJSON('/api/settings'));
    expect(err.message).toBe(body);
    expect(err.message).not.toMatch(/SHE_AUTH_TOKEN/);
  });

  it('租户那一道门的 401 体也不会被替换（两种门各有各的去路）', async () => {
    const body = 'Unauthorized：本地服务开了访问令牌（SHE_AUTH_TOKEN / SHE_AUTH_TOKENS），这次请求没带上。';
    stubFetch({ error: body }, 401);
    const err = await rejection(fetchJSON('/api/sessions'));
    expect(err.message).toBe(body);
  });

  it('body 不是 JSON 时（只有 HTTP 401）退回本地那句，而不是报一个空错误', async () => {
    const mock = vi.fn(async () => new Response('not json', { status: 401, statusText: 'Unauthorized' }));
    vi.stubGlobal('fetch', mock);
    await expect(fetchJSON('/api/sessions')).rejects.toThrow(/SHE_AUTH_TOKEN/);
  });

  it('别的错误状态照原样报，不要都算成鉴权问题', async () => {
    stubFetch({ error: 'Session not found: sess_x' }, 404);
    await expect(fetchJSON('/api/sessions/sess_x')).rejects.toThrow(/Session not found/);
  });
});
