/**
 * 联网工具的离线部分：解析、边界、以及**"没搜到"和"没问到"必须分开**。
 *
 * 这套东西最可能坏的方式不是崩，而是**安静地撒谎**：
 *
 *   - 对方改了结果页版式 → 解析出 0 条 → 如果没有那道判定，模型读到的就是"网上没有这件事"，
 *     然后它会照这个结论说话。所以下面钉的第一条就是：**认不出来 ≠ 没有结果**。
 *   - 免 key 的源靠解析网页，所以解析器必须对真实页面的噪音（导航链接、广告位、`<strong>`
 *     高亮、HTML 实体、跳转壳）有确定的答案，而不是"看着像就抓"。
 *   - `web_fetch` 跟的是**网页内容给的**地址，所以私网判定要在每一跳重定向上再判一次。
 *
 * 全部用注入的桩 fetch，不发真请求：门禁里不许有网络依赖，这一条和 `mcp-check` 的桩模型一致。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WebClient,
  resolveWebConfig,
  parseDuckDuckGoLite,
  parseBing,
  parseSearchBody,
  htmlToText,
  extractTitle,
  decodeEntities,
  isPrivateHost,
  assertFetchableUrl,
  classifyContentType,
  buildSearchRequest,
  MAX_PAGE_CHARS,
  type WebConfig,
} from '../web-client.js';
import {
  createWebTools,
  renderSearchResult,
  renderSearchError,
  renderFetchResult,
  renderFetchError,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
} from '../web-tools.js';
import { classifyToolResult } from '../tool-result.js';
import { isWorthRemembering } from '../errorbook.js';

/* ─────────────────────────── 夹具 ─────────────────────────── */

/** DuckDuckGo 轻量版的形状：结果链接带 class=result-link，摘要在后面的 result-snippet 单元格里。 */
const DDG_HTML = `
<table>
  <tr><td class="nav"><a href="/settings" class="nav-link">Settings</a></td></tr>
  <tr><td valign="top">1.&nbsp;</td><td><a rel="nofollow" href="https://example.com/a" class='result-link'>Example &amp; <strong>Title</strong></a></td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>First snippet with &#0183;&nbsp;entity.</td></tr>
  <tr><td valign="top">2.&nbsp;</td><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fb.example.org%2Fb%3Fx%3D1" class='result-link'>Second</a></td></tr>
  <tr><td>&nbsp;</td><td class='result-snippet'>Second snippet.</td></tr>
</table>`;

/** Bing 的形状：每条结果一个 li.b_algo，标题在里面的 h2>a，摘要在 b_caption 的 p 里。 */
const BING_HTML = `
<ol id="b_results">
  <li class="b_algo" data-id iid=SERP.1>
    <div class="b_tpcn"><a href="https://ignored.example" class="tilk">site</a></div>
    <h2 class=""><a href="https://example.com/a">Type<strong>Script</strong> &#183; docs</a></h2>
    <div class="b_caption"><p class="b_lineclamp2">A snippet &amp; more text.</p></div>
  </li>
  <li class="b_algo b_algoBorder">
    <h2><a href="https://b.example.org/">Second &#8212; result</a></h2>
    <div class="b_caption"><div>Fallback caption text</div></div>
  </li>
</ol>
<h2><a href="https://related.example">Related searches</a></h2>`;

const TAVILY_JSON = JSON.stringify({
  results: [
    { title: 'Doc', url: 'https://example.com/doc', content: 'Cleaned body text.', score: 0.9 },
    { title: 'No url', content: 'dropped' },
  ],
});

function cfg(over: Partial<WebConfig> = {}): WebConfig {
  return resolveWebConfig({ provider: 'duckduckgo', ...over });
}

/** 桩 fetch：按 URL 里出现的关键字选一个响应，并记下每一次请求。 */
function stubFetch(routes: Array<{ match: RegExp; reply: () => Response | Promise<Response> }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  /*
   * 两个参数写成 `string | URL` / `RequestInit`，而不是 DOM 的 `RequestInfo`：`RequestInfo` 只在
   * DOM 类型里（这个包的 tsconfig 不含 DOM lib），用它会让整个测试文件过不了 `tsc --noEmit`（也就是
   * `pnpm lint`）。末尾的 `as unknown as typeof fetch` 负责这一步的类型对接。
   */
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const route of routes) {
      if (route.match.test(url)) return route.reply();
    }
    return new Response('not routed', { status: 599 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });
/** undici 的超时错误长这样（`AbortSignal.timeout`）。和 `networkError` 一样是**工厂**：一个 Error
 * 实例被复用会被 `fetch` 的调用栈污染，而且 `throw timeoutError()` 才是调用点想写的形状。 */
const timeoutError = () => {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
};
const networkError = () => new TypeError('fetch failed');

/* ─────────────────────────── 1. 解析 ─────────────────────────── */

describe('结果页解析', () => {
  it('DuckDuckGo 轻量版：抓结果链接与摘要，跳过导航', () => {
    const hits = parseDuckDuckGoLite(DDG_HTML, 5);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].title, 'Example & Title');
    assert.equal(hits[0].url, 'https://example.com/a');
    assert.equal(hits[0].snippet, 'First snippet with · entity.');
    // `//duckduckgo.com/l/?uddg=` 是跳转壳，真正的地址在里面。
    assert.equal(hits[1].url, 'https://b.example.org/b?x=1');
    assert.equal(hits[1].snippet, 'Second snippet.');
  });

  it('DuckDuckGo：limit 真的限制了条数', () => {
    assert.equal(parseDuckDuckGoLite(DDG_HTML, 1).length, 1);
  });

  it('Bing：按 b_algo 切块，标题去标签解实体，尾部"相关搜索"的 h2 不算结果', () => {
    const hits = parseBing(BING_HTML, 5);
    assert.equal(hits.length, 2);
    assert.equal(hits[0].title, 'TypeScript · docs');
    assert.equal(hits[0].url, 'https://example.com/a');
    assert.equal(hits[0].snippet, 'A snippet & more text.');
    assert.equal(hits[1].url, 'https://b.example.org/');
    assert.equal(hits[1].title, 'Second — result');
    assert.ok(!hits.some((h) => h.url.includes('related.example')), '相关搜索不该被当成结果');
  });

  it('JSON 源：结果数组的形状能读，缺 url 的条目丢掉', () => {
    assert.deepEqual(parseSearchBody('tavily', TAVILY_JSON, 5), {
      hits: [{ title: 'Doc', url: 'https://example.com/doc', snippet: 'Cleaned body text.' }],
    });
  });

  /*
   * ── 这一条是整个文件的中心 ──
   *
   * 免 key 的源靠解析网页，所以"版式变了"一定会发生。它**必须**和"网上没有"分开：
   * 前者是"这次没问到"，后者是一句关于世界的话。混在一起，模型就会照后者说话。
   */
  it('【关键】版式变了要报"认不出来"，不能报"没搜到"', () => {
    const renamed = '<html><body><div class="result__body"><a href="https://x.example">X</a></div></body></html>';
    assert.deepEqual(parseSearchBody('duckduckgo', renamed, 5), { unreadable: true });
    assert.deepEqual(parseSearchBody('bing', '<html><body><div>nothing</div></body></html>', 5), { unreadable: true });
    // 而页面自己说"没有结果"时，那才是"没有结果"。
    const empty = '<html><body><div class="no-results">No results.</div></body></html>';
    assert.deepEqual(parseSearchBody('duckduckgo', empty, 5), { none: true });
  });

  it('JSON 源：坏 JSON、缺 results、空数组分别是三种结论', () => {
    assert.deepEqual(parseSearchBody('tavily', '<html>502</html>', 5), { unreadable: true });
    assert.deepEqual(parseSearchBody('tavily', '{"answer":"hi"}', 5), { unreadable: true });
    assert.deepEqual(parseSearchBody('searxng', '{"results":[]}', 5), { none: true });
  });
});

/* ─────────────────────────── 2. 文本 ─────────────────────────── */

describe('HTML → 文本', () => {
  it('丢掉脚本与样式、块级标签换成换行、解实体', () => {
    const text = htmlToText('<html><head><style>p{color:red}</style><script>var a = "<b>";</script></head>'
      + '<body><h1>标题</h1><p>第一段&nbsp;甲</p><p>第二段 &#8212; 乙</p></body></html>');
    assert.match(text, /^标题\n第一段\s甲\n第二段 — 乙$/);
    assert.ok(!text.includes('color:red'), '样式内容不能出现在正文里');
    assert.ok(!text.includes('var a'), '脚本内容不能出现在正文里');
  });

  it('页面里写成 &lt;script&gt; 的普通文本要留下来', () => {
    const text = htmlToText('<p>写 &lt;script&gt; 的时候</p>');
    assert.match(text, /写 <script> 的时候/);
  });

  it('标题：<title> 优先，没有就用第一个 <h1>', () => {
    assert.equal(extractTitle('<title>A &amp; B</title><h1>H</h1>'), 'A & B');
    assert.equal(extractTitle('<body><h1>只有 H1</h1></body>'), '只有 H1');
    assert.equal(extractTitle('<body>没有标题</body>'), '');
  });

  it('解实体：数字（含前导零）、十六进制、未知实体原样保留', () => {
    assert.equal(decodeEntities('&#0183;&#x27;&bogus;&amp;'), '·\'&bogus;&');
  });
});

/* ─────────────────────────── 3. 地址边界 ─────────────────────────── */

describe('地址边界', () => {
  it('本机/内网的字面地址被识别出来', () => {
    for (const host of ['localhost', 'a.localhost', 'x.internal', 'y.lan', '127.0.0.1', '127.1.2.3',
      '10.0.0.5', '172.16.0.1', '172.31.255.9', '192.168.1.1', '169.254.1.1', '100.64.0.1',
      '0.0.0.0', '::1', '[::1]', 'fc00::1', 'fd12:3456::1', 'fe80::1', '239.1.1.1']) {
      assert.equal(isPrivateHost(host), true, `${host} 应当被判为内网`);
    }
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', '2606:4700::1111']) {
      assert.equal(isPrivateHost(host), false, `${host} 不应当被判为内网`);
    }
  });

  it('只接受 http/https；没写 scheme 补 https；带用户名密码的拒绝', () => {
    assert.equal(assertFetchableUrl('example.com/page').ok, true);
    const ok = assertFetchableUrl('example.com/page');
    assert.equal(ok.ok && ok.url.protocol, 'https:');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x</b>', '', 'ftp://x/y']) {
      const guard = assertFetchableUrl(bad);
      assert.equal(guard.ok, false, `${bad} 应当被拒`);
    }
    assert.equal(assertFetchableUrl('https://user:pw@example.com/').ok, false);
    const blocked = assertFetchableUrl('http://127.0.0.1:8080/admin');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.ok === false && blocked.kind, 'blocked_host');
  });

  it('内容类型：文本类可读，二进制不猜', () => {
    assert.equal(classifyContentType('text/html; charset=utf-8'), 'html');
    assert.equal(classifyContentType('application/xhtml+xml'), 'html');
    assert.equal(classifyContentType('text/plain'), 'text');
    assert.equal(classifyContentType('application/json'), 'text');
    assert.equal(classifyContentType('application/pdf'), 'other');
    assert.equal(classifyContentType('image/png'), 'other');
    assert.equal(classifyContentType(''), 'text');
  });

  it('搜索请求按源拼，缺 key 的源直接说清', () => {
    const ddg = buildSearchRequest('duckduckgo', cfg(), 'a b', 5);
    assert.equal(ddg.ok && ddg.request.url.includes('q=a%20b'), true);
    const tavily = buildSearchRequest('tavily', cfg({ provider: 'tavily' }), 'q', 3);
    assert.equal(tavily.ok, false);
    assert.match(tavily.ok === false ? tavily.detail : '', /API key/);
    const searx = buildSearchRequest('searxng', cfg({ provider: 'searxng' }), 'q', 3);
    assert.equal(searx.ok, false);
  });

  it('配置夹到有意义的区间：0 条结果、分钟级的超时都不是"设置"', () => {
    assert.equal(resolveWebConfig({ maxResults: 0 }).maxResults, 5);
    assert.equal(resolveWebConfig({ maxResults: 999 }).maxResults, 20);
    assert.equal(resolveWebConfig({ timeoutMs: 10 }).timeoutMs, 15_000);
    assert.equal(resolveWebConfig({ provider: 'nonsense' as never }).provider, 'auto');
    assert.equal(resolveWebConfig(undefined).provider, 'auto');
  });
});

/* ─────────────────────────── 4. 搜索：五种结局 ─────────────────────────── */

describe('搜索的结局', () => {
  it('有结果：点名源，并把"线索不是答案"写进结果', async () => {
    const { impl } = stubFetch([{ match: /duckduckgo/, reply: () => html(DDG_HTML) }]);
    const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.search('测试');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.source, 'duckduckgo');
    assert.equal(outcome.ok && outcome.via, 'explicit');
    const text = outcome.ok ? renderSearchResult(outcome) : '';
    assert.match(text, /来源：DuckDuckGo/);
    assert.match(text, new RegExp(WEB_FETCH_TOOL), '结果里要指向 web_fetch');
    assert.equal(classifyToolResult(WEB_SEARCH_TOOL, text).kind, 'none');
  });

  it('没有结果：单行、点名问了谁，且被判成 empty（"这就是答案"）', async () => {
    const { impl } = stubFetch([{
      match: /duckduckgo/,
      reply: () => html('<div class="no-results">No results.</div>'),
    }]);
    const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.search('zzz');
    const text = outcome.ok ? renderSearchResult(outcome) : renderSearchError(outcome as never);
    assert.equal(text, '没有找到结果（问了 DuckDuckGo）');
    assert.equal(classifyToolResult(WEB_SEARCH_TOOL, text).kind, 'empty');
  });

  /*
   * ── 整个功能里最坏的一种假话 ──
   *
   * 解析不出来 ≠ 没有结果。渲染出来的那句话还必须被判成 `service`（"没问到"），不能掉进
   * `none`（"拿到了数据"）或 `empty`（"没有"）—— 后者会让模型开始替搜索引擎编内容。
   */
  it('【关键】解析不出来时报"没问到"，且不判成 empty / none', async () => {
    const { impl } = stubFetch([{
      match: /duckduckgo/,
      reply: () => html('<html><body><div class="结果" data-x="1">换了版式</div></body></html>'),
    }]);
    const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.search('x');
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok === false ? outcome.detail : '', /认不出来/);
    const text = renderSearchError(outcome as never);
    const kind = classifyToolResult(WEB_SEARCH_TOOL, text).kind;
    assert.equal(kind, 'service', `实际 ${kind}：${text}`);
    assert.notEqual(kind, 'empty');
  });

  it('状态码分四类：429 / 500 / 401 各自给出不同的下一步', async () => {
    const cases: Array<[number, string]> = [[429, 'rate_limited'], [500, 'service'], [401, 'permission']];
    for (const [status, expected] of cases) {
      const { impl } = stubFetch([{ match: /duckduckgo/, reply: () => new Response('x', { status }) }]);
      const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
      const outcome = await client.search('x');
      assert.equal(outcome.ok, false);
      const text = renderSearchError(outcome as never);
      assert.equal(classifyToolResult(WEB_SEARCH_TOOL, text).kind, expected, `${status} → ${text}`);
    }
  });

  it('超时与连不上分别归 timeout / service，且都判成可重试', async () => {
    for (const [err, expected] of [[timeoutError(), 'timeout'], [networkError(), 'service']] as const) {
      const { impl } = stubFetch([{ match: /duckduckgo/, reply: () => { throw err; } }]);
      const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
      const outcome = await client.search('x');
      assert.equal(outcome.ok, false);
      const verdict = classifyToolResult(WEB_SEARCH_TOOL, renderSearchError(outcome as never));
      assert.equal(verdict.kind, expected);
      assert.equal(verdict.retryable, true, '瞬时失败要比永久失败多一次机会');
    }
  });

  it('关闭档位：拒绝并说清改哪个变量（判成"工具不可用"，不是失败）', async () => {
    const { impl, calls } = stubFetch([]);
    const client = new WebClient(cfg({ provider: 'off' }), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.search('x');
    assert.equal(outcome.ok, false);
    assert.equal(calls.length, 0, '关了就不该发任何请求');
    const text = renderSearchError(outcome as never);
    assert.match(text, /SHE_WEB_PROVIDER/);
    assert.equal(classifyToolResult(WEB_SEARCH_TOOL, text).kind, 'unavailable');
  });

  it('空 query 与缺 key 的源：参数/凭据的错不靠换源解决', async () => {
    const { impl, calls } = stubFetch([]);
    const empty = await new WebClient(cfg(), { fetchImpl: impl, now: () => 0 }).search('   ');
    assert.equal(empty.ok, false);
    assert.equal(classifyToolResult(WEB_SEARCH_TOOL, renderSearchError(empty as never)).kind, 'invalid_args');

    const tavily = await new WebClient(cfg({ provider: 'tavily' }), { fetchImpl: impl, now: () => 0 }).search('x');
    assert.equal(tavily.ok, false);
    assert.equal(classifyToolResult(WEB_SEARCH_TOOL, renderSearchError(tavily as never)).kind, 'permission');
    assert.equal(calls.length, 0);
  });

  /*
   * 不变量：**文案被判成哪一类，必须和 outcome 自己声明的类一致**（`off` 这类没有自己的"失败类
   * 别"的除外，它按设计落进 `unavailable`）。
   *
   * 为什么单列一张表：文案里嵌着每个源的症状原文，而分类器是在**整段文本**上按固定顺序找第一个
   * 命中的症状。于是"聚合出来的类"和"读出来的类"是两条会分叉的路径 —— 一个源超时、另一个源 503
   * 时，原实现声明 service，而文本里的"超时（15000ms）"让它被读成 timeout。分叉的后果不是文案
   * 难看，是模型看到"超时，可以原样重试"而错题本记的是另一回事。
   */
  it('【不变量】每个类别的文案都被判成约定的那一类（文本与声明不分叉）', () => {
    const cases: Array<[string, string]> = [
      ['off', 'unavailable'],
      ['invalid_args', 'invalid_args'],
      ['timeout', 'timeout'],
      ['rate_limited', 'rate_limited'],
      ['service', 'service'],
      ['auth', 'permission'],
      ['blocked_host', 'policy_denied'],
      ['not_found', 'not_found'],
    ];
    for (const [kind, expected] of cases) {
      // 症状原文用一句中性的话：这里要验的是**类别本身**的文案，不是某一家的错误文本。
      const outcome = { ok: false as const, kind, detail: 'HTTP 400（对方说这个请求不对）', tried: ['duckduckgo' as const], missed: [] };
      const text = renderSearchError(outcome as never);
      assert.equal(classifyToolResult(WEB_SEARCH_TOOL, text).kind, expected, `${kind} → ${text}`);
    }
  });
});

/* ─────────────────────────── 5. auto：换源、记忆、以及跳过要说出来 ─────────────────────────── */

describe('auto 依次试免 key 的源', () => {
  it('第一个超时、第二个答上：结果说是 Bing 答的，并写明谁没答上来', async () => {
    const { impl, calls } = stubFetch([
      { match: /duckduckgo/, reply: () => { throw timeoutError(); } },
      { match: /bing\.com/, reply: () => html(BING_HTML) },
    ]);
    const client = new WebClient(cfg({ provider: 'auto' }), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.search('x');
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.source, 'bing');
    assert.equal(outcome.ok && outcome.via, 'auto');
    const text = outcome.ok ? renderSearchResult(outcome) : '';
    assert.match(text, /来源：Bing（自动选的）/);
    /*
     * 第一次调用时并没有"被跳过"的源（DuckDuckGo 是**问过**了、超时了）。两者必须分开写：
     * "跳过了"是记忆在起作用（这次没问），"没答上来"带着症状 —— 混成一句就把"问了没答"
     * 说成了"根本没问"。
     */
    assert.match(text, /（DuckDuckGo 这次没答上来：超时（15000ms）；十分钟内不再试它）/);
    assert.ok(!/跳过：/.test(text), '这一次问了它，不能说成"跳过"');
    assert.equal(calls.length, 2, '两个源各试了一次');
  });

  /*
   * 记不住"哪个源连不上"，每一次调用都要白等一次完整的超时 —— 15 秒乘上每一次搜索。但记忆必须是
   * **有痕迹的**：它体现在结果里的"跳过"那一行，而不是悄悄换一个源。
   */
  it('【关键】连不上的源会被记下来，下次不再白等；跳过这件事写在结果里', async () => {
    let clock = 0;
    const { impl, calls } = stubFetch([
      { match: /duckduckgo/, reply: () => { throw timeoutError(); } },
      { match: /bing\.com/, reply: () => html(BING_HTML) },
    ]);
    const client = new WebClient(cfg({ provider: 'auto' }), { fetchImpl: impl, now: () => clock });
    await client.search('one');
    const afterFirst = calls.length;
    const second = await client.search('two');
    assert.equal(calls.length, afterFirst + 1, '第二次不该再试那个超时的源');
    assert.equal(client.config.provider, 'auto', '换的只是"试哪一个"，档位没被动过');
    assert.match(second.ok ? renderSearchResult(second) : '', /跳过：DuckDuckGo/);

    // 过了记忆窗口就再试一次：一次抖动不该等于永久故障。
    clock += 11 * 60_000;
    await client.search('three');
    assert.equal(calls.length, afterFirst + 1 + 2, '窗口过期后两个源都该再试');
  });

  it('全都答不上来：错误里逐个源点名，不假装"没有结果"', async () => {
    const { impl } = stubFetch([
      { match: /duckduckgo/, reply: () => { throw timeoutError(); } },
      { match: /bing\.com/, reply: () => new Response('down', { status: 503 }) },
    ]);
    const client = new WebClient(cfg({ provider: 'auto' }), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.search('x');
    assert.equal(outcome.ok, false);
    const detail = outcome.ok === false ? outcome.detail : '';
    assert.match(detail, /DuckDuckGo：超时/);
    assert.match(detail, /Bing：HTTP 503/);
    if (outcome.ok) return;
    /*
     * 类别是**推**出来的，不是"最后一个源的那类"：一个超时 + 一个 503 的混合失败，报哪一类取决于
     * 分类器先看到哪个症状（它按 timeout → rate_limited → service → … 的顺序找），所以聚合时的
     * 判定用的是同一张顺序表。这里断言的是不变量：**文案被判成哪一类，必须和 outcome.kind 一致** ——
     * 否则模型看到的"超时，可以重试"和错题本记的"服务不可用"就是两件事（原来的实现就栽在这）。
     */
    assert.equal(outcome.kind, 'timeout', '有源超时，按分类器的优先级就是 timeout');
    assert.equal(classifyToolResult(WEB_SEARCH_TOOL, renderSearchError(outcome)).kind, outcome.kind);
  });

  it('两个源都说没有结果：合并成一句，且列出两个源', async () => {
    const empty = '<div class="no-results">No results.</div>';
    const { impl } = stubFetch([
      { match: /duckduckgo/, reply: () => html(empty) },
      { match: /bing\.com/, reply: () => html(empty) },
    ]);
    const client = new WebClient(cfg({ provider: 'auto' }), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.search('x');
    const text = outcome.ok ? renderSearchResult(outcome) : renderSearchError(outcome as never);
    assert.equal(text, '没有找到结果（问了 DuckDuckGo、Bing）');
    assert.equal(classifyToolResult(WEB_SEARCH_TOOL, text).kind, 'empty');
  });

  it('显式指定的源不会偷偷换成另一个', async () => {
    const { impl, calls } = stubFetch([{ match: /bing\.com/, reply: () => html(BING_HTML) }]);
    const client = new WebClient(cfg({ provider: 'duckduckgo' }), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.search('x');
    assert.equal(outcome.ok, false, '指定的源没答上来就是失败');
    assert.equal(calls.every((c) => c.url.includes('duckduckgo')), true);
  });
});

/* ─────────────────────────── 6. 取页 ─────────────────────────── */

describe('取页', () => {
  it('HTML 页面：去标签成正文、带标题与最终地址', async () => {
    const { impl } = stubFetch([{
      match: /example\.com/,
      reply: () => html('<html><head><title>页面标题</title><style>b{}</style></head><body><p>正文第一段。</p><script>x()</script><p>第二段。</p></body></html>'),
    }]);
    const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.fetchPage('example.com/page');
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.title, '页面标题');
    assert.equal(outcome.text, '正文第一段。\n第二段。');
    assert.equal(outcome.url, 'https://example.com/page');
    const text = renderFetchResult(outcome);
    assert.match(text, /地址：https:\/\/example\.com\/page/);
    assert.equal(classifyToolResult(WEB_FETCH_TOOL, text).kind, 'none');
  });

  it('私网地址：拒绝，且判成 policy_denied（边界在按设计工作，不是错题）', async () => {
    const { impl, calls } = stubFetch([]);
    const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.fetchPage('http://localhost:5577/api/settings');
    assert.equal(outcome.ok, false);
    assert.equal(calls.length, 0, '拒绝了就不该发请求');
    const text = renderFetchError(outcome as never);
    const verdict = classifyToolResult(WEB_FETCH_TOOL, text);
    assert.equal(verdict.kind, 'policy_denied', text);
    assert.equal(isWorthRemembering(verdict.kind), false, '边界拒绝不该被记成 agent 的错题');
  });

  /*
   * 重定向是这道边界唯一的绕过口：一个公网地址用 302 就能把这次读取指回本机服务。所以每一跳都要
   * 重新判一次 —— 只判第一次等于没判。
   */
  it('【关键】重定向每一跳都重新过私网判定', async () => {
    const { impl, calls } = stubFetch([
      {
        match: /public\.example/,
        reply: () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9000/secret' } }),
      },
    ]);
    const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.fetchPage('https://public.example/go');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.kind, 'blocked_host');
    assert.equal(calls.length, 1, '第二跳就不该发出去');
    assert.equal(classifyToolResult(WEB_FETCH_TOOL, renderFetchError(outcome as never)).kind, 'policy_denied');
  });

  it('正常跳转：跟过去、结果里写明请求的地址与最终地址', async () => {
    const { impl, calls } = stubFetch([
      { match: /^https:\/\/a\.example/, reply: () => new Response(null, { status: 301, headers: { location: 'https://b.example/real' } }) },
      { match: /b\.example\/real/, reply: () => html('<title>到了</title><p>正文</p>') },
    ]);
    const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.fetchPage('https://a.example/start');
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(calls.length, 2);
    assert.equal(outcome.url, 'https://b.example/real');
    assert.equal(outcome.requested, 'https://a.example/start');
    assert.match(renderFetchResult(outcome), /跟了 1 跳/);
  });

  it('跳转打转：说有上限，不无限跟', async () => {
    const { impl, calls } = stubFetch([
      { match: /loop\.example/, reply: () => new Response(null, { status: 302, headers: { location: 'https://loop.example/again' } }) },
    ]);
    const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.fetchPage('https://loop.example/start');
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok === false ? outcome.detail : '', /跳转超过/);
    assert.ok(calls.length <= 5, '不能无限跟下去');
  });

  it('不可以读的类型：拒绝并说出类型（判成 invalid_args）', async () => {
    const { impl } = stubFetch([{
      match: /example\.com/,
      reply: () => new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    }]);
    const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.fetchPage('https://example.com/x.pdf');
    assert.equal(outcome.ok, false);
    const text = renderFetchError(outcome as never);
    assert.match(text, /application\/pdf/);
    assert.equal(classifyToolResult(WEB_FETCH_TOOL, text).kind, 'invalid_args');
  });

  it('404：判成 not_found，并说清原样重试没有意义', async () => {
    const { impl } = stubFetch([{ match: /example\.com/, reply: () => new Response('gone', { status: 404 }) }]);
    const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.fetchPage('https://example.com/gone');
    const text = renderFetchError(outcome as never);
    assert.equal(classifyToolResult(WEB_FETCH_TOOL, text).kind, 'not_found');
    assert.match(text, /原样重试/);
  });

  it('字节上限：到顶就停，并在结果里说明没读完', async () => {
    const big = '<p>' + 'x'.repeat(10_000) + '</p>';
    const { impl } = stubFetch([{ match: /example\.com/, reply: () => html(big) }]);
    const client = new WebClient(cfg({ maxFetchBytes: 4096 }), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.fetchPage('https://example.com/big');
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.truncatedBytes, true);
    assert.ok(outcome.bytes <= 4096, `读到 ${outcome.bytes} 字节`);
    assert.match(renderFetchResult(outcome), /没读/);
  });

  it('字符上限：截断并明说截断了（"读完了"和"读了开头"要能分开）', async () => {
    const body = '<p>' + 'y'.repeat(MAX_PAGE_CHARS + 5_000) + '</p>';
    const { impl } = stubFetch([{ match: /example\.com/, reply: () => html(body) }]);
    const client = new WebClient(cfg({ maxFetchBytes: 1024 * 1024 }), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.fetchPage('https://example.com/long');
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.truncatedChars, true);
    assert.equal(outcome.text.length, MAX_PAGE_CHARS);
    assert.match(renderFetchResult(outcome), new RegExp(String(MAX_PAGE_CHARS)));
  });

  it('没有可读文本的页面：说清"没有文本"，不编一句总结', async () => {
    const { impl } = stubFetch([{
      match: /example\.com/,
      reply: () => json('{"a":1}'),
    }]);
    const client = new WebClient(cfg(), { fetchImpl: impl, now: () => 0 });
    const outcome = await client.fetchPage('https://example.com/api');
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const text = renderFetchResult(outcome);
    assert.match(text, /application\/json/);
    assert.match(text, /\{"a":1\}/);
  });

  /*
   * 取页侧的同一张不变量表：文案被判成哪一类，和 outcome 声明的类要对得上。取页的各类别里，
   * `content_type` 归 `invalid_args`（`WebFailureKind.invalid_args` 自己的注释就把"内容类型读不了"
   * 算在参数层），`blocked_host` 归 `policy_denied`（边界按设计工作）。这张表同时是措辞的回归网：
   * 谁改了文案里的判据短语，这里立刻红。
   */
  it('【不变量】取页每个类别的文案都被判成约定的那一类', () => {
    const cases: Array<[string, string]> = [
      ['off', 'unavailable'],
      ['invalid_args', 'invalid_args'],
      ['blocked_host', 'policy_denied'],
      ['timeout', 'timeout'],
      ['rate_limited', 'rate_limited'],
      ['service', 'service'],
      ['auth', 'permission'],
      ['not_found', 'not_found'],
      ['content_type', 'invalid_args'],
    ];
    for (const [kind, expected] of cases) {
      const text = renderFetchError({ ok: false as const, kind: kind as never, detail: 'HTTP 400（对方说这个请求不对）' });
      assert.equal(classifyToolResult(WEB_FETCH_TOOL, text).kind, expected, `${kind} → ${text}`);
    }
  });
});

/* ─────────────────────────── 7. 工具表 ─────────────────────────── */

describe('工具定义', () => {
  it('两个工具都在，描述里点名在用的是哪个源', () => {
    const explicit = createWebTools({ provider: 'bing', maxResults: 3 });
    assert.deepEqual(explicit.definitions.map((d) => d.name), [WEB_SEARCH_TOOL, WEB_FETCH_TOOL]);
    const search = explicit.definitions[0].description;
    assert.match(search, /Bing/, '描述必须说出在用的是哪个源');
    assert.match(search, /leads, not answers/i);
    assert.match(search, new RegExp(WEB_FETCH_TOOL));
    assert.match(explicit.definitions[1].description, new RegExp(String(MAX_PAGE_CHARS)));

    const auto = createWebTools({ provider: 'auto' });
    assert.match(auto.definitions[0].description, /DuckDuckGo \/ Bing/);
    const off = createWebTools({ provider: 'off' });
    assert.match(off.definitions[0].description, /off/);
  });

  it('执行：未知工具名不假装成功；两个工具名各自路由', async () => {
    const { impl } = stubFetch([
      { match: /duckduckgo/, reply: () => html(DDG_HTML) },
      { match: /example\.com/, reply: () => html('<title>T</title><p>body</p>') },
    ]);
    const tools = createWebTools({ provider: 'duckduckgo' }, { fetchImpl: impl, now: () => 0 });
    const hit = await tools.execute(WEB_SEARCH_TOOL, { query: 'x' });
    assert.match(hit, /1\. Example & Title/);
    const page = await tools.execute(WEB_FETCH_TOOL, { url: 'https://example.com/' });
    assert.match(page, /body/);
    const unknown = await tools.execute('web_open', {});
    assert.match(unknown, /unknown tool/);
    assert.equal(classifyToolResult('web_open', unknown).kind, 'unavailable');
  });

  it('参数不是字符串时不崩：空 query / 空 url 走各自那条拒绝', async () => {
    const { impl } = stubFetch([]);
    const tools = createWebTools({ provider: 'duckduckgo' }, { fetchImpl: impl, now: () => 0 });
    assert.match(await tools.execute(WEB_SEARCH_TOOL, {}), /缺少可用的 query/);
    assert.match(await tools.execute(WEB_FETCH_TOOL, { url: 42 }), /必须是一个 http\/https/);
  });
});
