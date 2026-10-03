/**
 * `web_search` / `web_fetch` —— 让 Agent 自己去网上查资料。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 两个工具，缺一不可，而且分工要说清
 *
 *   `web_search`  关键词 → 若干条 `{标题, 网址, 摘要}`
 *   `web_fetch`   一个网址 → 正文（去标签、截断、带最终地址）
 *
 * 只有搜索时，模型会把摘要当成事实引用（摘要来自搜索引擎的抓取，可能过期、可能被截断、可能根本
 * 不是页面里的一句话）；只有取页时，它得先知道网址。所以搜索结果的末尾**必须**写清"这是线索"，
 * 并且点名下一步是 `web_fetch` —— 这句话不是客套，它是这两个工具之间的接口。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 说明里必须写"在用的是哪个源"
 *
 * `describe()` 从配置里渲染（不是写死一句"本工具可以联网"）。理由和 `shellDialectDescription`
 * 一样：模型没法为一个没被告知的源写对参数，而读者（和评测）需要能从描述里核对事实 —— 描述说
 * DuckDuckGo，请求里就该是 DuckDuckGo。
 *
 * 每条**结果**也点名源（含 `auto` 里"谁答的、谁被跳过"），因为它们可能不是同一个：自动模式下
 * DDG 连不上、Bing 答的，那么"搜到了什么"这件事的来源就是 Bing，而不是配置里那个首选。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 出网这件事是明说的，不是埋着的
 *
 * 每一次调用都是把关键词/地址发给第三方。所以：描述里点名源；结果里点名源；`off` 档位拒绝时说清
 * 楚改哪个变量能开回来（而不是假装"搜不到"）。工具本身**不需要**确认门 —— 它只读、不改工作区 ——
 * 但对"要不要把这件事发出去"这个决定，用户有一票：`SHE_WEB_PROVIDER=off`。
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { ToolDefinition } from '@she/shared';
import {
  WebClient,
  MAX_PAGE_CHARS,
  SOURCE_SHORT,
  AUTO_ORDER,
  type FetchOutcome,
  type SearchOutcome,
  type WebConfig,
  type WebDeps,
  type WebSource,
} from './web-client.js';

export const WEB_SEARCH_TOOL = 'web_search';
export const WEB_FETCH_TOOL = 'web_fetch';

/**
 * 出错时给模型的那句话。
 *
 * 每一句都要能被 `tool-result.ts` 分类（门禁会扫源码里所有 `Error: ` 文案），所以措辞不是随便
 * 挑的：`工具不可用`、`缺少`、`超时`、`限流`、`服务不可用`、`权限不足`、`不存在`、`必须给`、
 * `本机/内网` 分别对应八个类别 —— 八个类别给八条不同的下一步。
 */
export function renderSearchError(outcome: Extract<SearchOutcome, { ok: false }>): string {
  const tried = outcome.tried.map((s) => SOURCE_SHORT[s]).join('、');
  const where = tried ? `${tried} 都试过了：${outcome.detail}` : outcome.detail;
  switch (outcome.kind) {
    case 'off':
      return 'Error: 联网工具不可用：SHE_WEB_PROVIDER=off 把 web_search / web_fetch 关掉了。'
        + '这不是失败、重试也不会变，要开回来说一声就行 —— 用户在 .env 里写 SHE_WEB_PROVIDER=auto'
        + '（免 key：先试 DuckDuckGo 再试 Bing）或某个具体源，重启服务即可。';
    case 'invalid_args':
      return `Error: web_search 缺少可用的 query（必填）：${outcome.detail}`
        + '用一句话说清要查什么，不要把整段需求原样贴进去。';
    case 'timeout':
      return `Error: 搜索超时（${where}）—— 可以原样重试一次；再超时就说明这台机器到搜索源不通，`
        + '把结论写成"没能查到"并说明原因，不要反复重试。';
    case 'rate_limited':
      return `Error: 搜索被限流（${where}）—— 隔一会儿再用同一个调用通常有效，但不要紧凑地连续重试。`;
    case 'auth':
      return `Error: 搜索源拒绝了凭据（${where}）—— 权限不足：检查 SHE_WEB_API_KEY 是否正确、是否有额度，`
        + '或换一个不需要 key 的源（duckduckgo / bing）。原样重试不会有不同结果。';
    case 'blocked_host':
      /*
       * 搜索**不会**走到这里：源地址来自配置（`baseUrl` 指向自建的 SearXNG 是本机地址，那是合法的），
       * 私网判定只加在 `web_fetch` 上 —— 它跟的是**网页内容给的**地址，那才是要防的方向。这一支留着
       * 只是为了让 union 的处理保持完整，真走到这里说明有人给搜索也加了一道边界。
       */
      return `Error: web_search 不读本机/内网地址（${outcome.detail}）：搜索源应当来自配置。`;
    case 'not_found':
      /*
       * 单列一支，而不是落进下面的 `default`：`default` 说的是"服务不可用"（5xx / 连不上），
       * 而这一支说的是"地址/端点是错的"——重试和服务端都没关系，改配置才行。少这一支的时候，
       * 一段以"服务不可用"结尾的文案会把 404 读成 5xx（文本与判定打架的一种）。
       */
      return `Error: 搜索源说这个地址不存在（${where}）—— 原样重试不会有不同结果：`
        + '搜索源的地址来自配置（内置默认或 SHE_WEB_BASE_URL），先确认它没写错。';
    default:
      return `Error: 搜索没能拿到结果（${where}）—— 服务不可用：先原样重试一次，`
        + '还是不行就说明现状（哪几个源、什么症状），换源是用户的决定（SHE_WEB_PROVIDER）。';
  }
}

/** 搜索成功的正文。空结果是**答案**，所以单列一行，且整段就是这个形状（`empty` 判定的哨兵）。 */
export function renderSearchResult(outcome: Extract<SearchOutcome, { ok: true }>): string {
  if (!outcome.hits.length) {
    return `没有找到结果（问了 ${outcome.tried.map((s) => SOURCE_SHORT[s]).join('、')}）`;
  }
  const head = [
    `搜索：${outcome.query}`,
    `来源：${SOURCE_SHORT[outcome.source]}${outcome.via === 'auto' ? '（自动选的）' : ''}`,
  ];
  /*
   * 这一次问了但没答上来的源，逐个点名并带上症状。
   *
   * 这一行不是装饰：`auto` 底下"谁答的"决定了这条结果的来源，而"谁没答上来"决定了这句话有多完整 ——
   * 只写"来源：Bing"的话，读者不知道 DuckDuckGo 是没被问过、还是问了没答。两种情况的含义不一样
   * （前者是记忆跳过了，后者是它现在不可用），所以两者分开写。
   */
  for (const m of outcome.missed) {
    const staysDown = m.kind === 'timeout' || m.kind === 'service';
    head.push(`（${SOURCE_SHORT[m.source]} 这次没答上来：${m.detail}${staysDown ? '；十分钟内不再试它' : ''}）`);
  }
  if (outcome.skipped.length) {
    head.push(`（跳过：${outcome.skipped.map((s) => SOURCE_SHORT[s]).join('、')} —— 刚才连不上，十分钟内不再试它）`);
  }
  const lines = outcome.hits.map((hit, i) => {
    const parts = [`${i + 1}. ${hit.title || '（没有标题）'}`, `   ${hit.url}`];
    if (hit.snippet) parts.push(`   ${hit.snippet}`);
    return parts.join('\n');
  });
  return [
    ...head, '',
    ...lines, '',
    `这些是搜索结果的摘要，是线索不是答案：要引用其中的说法，先用 ${WEB_FETCH_TOOL} 打开那一条读到正文，`
    + '正文里没有的就不要说成已知。',
  ].join('\n');
}

/** `web_fetch` 的失败。理由同 `renderSearchError`：每一句都要能被分类。 */
export function renderFetchError(outcome: Extract<FetchOutcome, { ok: false }>): string {
  const hops = outcome.redirected?.length ? `（跟了 ${outcome.redirected.length} 跳：${outcome.redirected.join(' → ')}）` : '';
  switch (outcome.kind) {
    case 'off':
      return 'Error: 联网工具不可用：SHE_WEB_PROVIDER=off 把 web_search / web_fetch 关掉了。'
        + '要开回来说一声，用户在 .env 里改 SHE_WEB_PROVIDER 后重启。';
    case 'blocked_host':
      return `Error: web_fetch 拒绝访问本机/内网地址（${outcome.detail}）${hops}：`
        + '这类地址可能是本机上不该被网页内容读到的服务。要读本机的东西请用 shell（curl 等）。';
    case 'invalid_args':
      return `Error: web_fetch 的 url 必须是一个 http/https 的网页地址（${outcome.detail}）${hops}。`
        + '只接受文本类页面（text/html、纯文本、JSON、XML、Markdown、CSV）。';
    case 'not_found':
      return `Error: 这个地址不存在或已失效（${outcome.detail}）${hops}—— 原样重试一定还是同样的结果；`
        + '回 ${WEB_SEARCH_TOOL} 换一条结果，或确认网址是不是抄错了。';
    case 'content_type':
      /*
       * 措辞是**按分类判据**写的：`url 只能是…` 命中 `invalid_args` 规则（见 web-client.ts 里
       * `WebFailureKind.invalid_args` 自己的注释 ——"参数本身不对：空 query、非 http(s) 的地址、
       * 内容类型读不了"）。
       *
       * 第一版写的是"读不了这个类型…"，判据藏在**第二个**拼接片段里（"必须给一个能读它的工具"）。
       * 运行时能分类，但 `check:toolresult` 的静态扫描只取模板串的**第一段**（拼接不合并），于是这条
       * 文案被判成 `unknown`：门禁红的就是它。把判据放进第一段，两种读法才一致。
       */
      return `Error: web_fetch 读不了这个类型（${outcome.detail}）${hops}—— url 只能是文本类页面的地址`
        + '（text/html、纯文本、JSON、XML、Markdown、CSV）。非文本内容（PDF、图片、压缩包）'
        + '必须用能读它的工具，或让用户提供可读的版本 —— 不要假装读到了。';
    case 'auth':
      return `Error: 对方拒绝了这次读取（${outcome.detail}）${hops}—— 权限不足：需要登录或对方在反爬。`
        + '换一条来源，或如实说明这个页面读不到；重试同样的地址不会有不同结果。';
    case 'timeout':
      return `Error: 取页超时（${outcome.detail}）${hops}—— 可以重试一次；再超时就换一条来源。`;
    case 'rate_limited':
      return `Error: 对方在限流（${outcome.detail}）${hops}—— 隔一会儿再试，不要紧凑地连续重试。`;
    default:
      return `Error: 取页失败（${outcome.detail}）${hops}—— 服务不可用：可以重试一次；`
        + '连续失败就是对方的问题，直接说明现状，不要反复重试。';
  }
}

/** `web_fetch` 成功时的正文。截断、跳转、类型都必须写在结果里 —— 读者据此判断能引用多少。 */
export function renderFetchResult(outcome: Extract<FetchOutcome, { ok: true }>): string {
  const head: string[] = [];
  head.push(`页面：${outcome.title || '（没有标题）'}`);
  head.push(`地址：${outcome.url}`);
  if (outcome.hops.length) head.push(`（请求的是 ${outcome.requested}，跟了 ${outcome.hops.length} 跳重定向）`);
  head.push(`类型：${outcome.contentType}；状态：${outcome.status}；取回 ${outcome.bytes} 字节${outcome.truncatedBytes ? '（已到字节上限，后面的内容没读）' : ''}`);
  const body = outcome.text
    ? outcome.text
    : '（这个页面没有可读文本：可能是脚本渲染、图片，或需要登录。）';
  const notes: string[] = [];
  if (outcome.truncatedChars) {
    notes.push(`（正文超过 ${MAX_PAGE_CHARS} 字符，只给了开头 —— 需要更多就换更具体的页面，或用 shell 抓取后自己切。）`);
  }
  return [...head, '', body, ...(notes.length ? ['', ...notes] : [])].join('\n');
}

export function createWebTools(
  webConfig: Partial<WebConfig> | undefined,
  deps: WebDeps = {},
): {
  definitions: ToolDefinition[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
} {
  const client = new WebClient(webConfig, deps);
  const providerNames = AUTO_ORDER.map((s: WebSource) => SOURCE_SHORT[s]).join(' / ');

  const searchDefinition: ToolDefinition = {
    name: WEB_SEARCH_TOOL,
    description:
      'Search the web for a keyword query and return a few results (title, URL, snippet). '
      + 'The snippets are LEADS, not answers: before relying on any claim, open the result with '
      + `${WEB_FETCH_TOOL} and read the page text — say "I could not open it" rather than quoting a snippet as fact. `
      + `Source: ${client.describe()} `
      + `The query text leaves this machine and goes to that source; every result names the source that answered. `
      + `Free sources (${providerNames}) are parsed result pages, not official APIs, so a layout change upstream is reported `
      + 'as "response unrecognisable", never as "no results found".',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for — a few words, not a whole paragraph' },
      },
      required: ['query'],
    },
  };

  const fetchDefinition: ToolDefinition = {
    name: WEB_FETCH_TOOL,
    description:
      'Open one URL and return its readable text (HTML is stripped of tags and scripts), with the final URL after redirects. '
      + 'Read-only. Text-like pages only (html, plain text, JSON, XML, Markdown, CSV); PDFs, images and other binaries are refused with their type rather than guessed at. '
      + `Content is truncated at ${MAX_PAGE_CHARS} characters and says so. `
      + 'Loopback and private-network addresses are refused on every redirect hop (literal host names only — a public name that resolves to a private address is not caught). '
      + `Use it after ${WEB_SEARCH_TOOL}, on the results worth reading.`,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL, e.g. https://example.com/page' },
      },
      required: ['url'],
    },
  };

  return {
    definitions: [searchDefinition, fetchDefinition],
    execute: async (name, args) => {
      if (name === WEB_SEARCH_TOOL) {
        const query = typeof args.query === 'string' ? args.query : '';
        const outcome = await client.search(query);
        return outcome.ok ? renderSearchResult(outcome) : renderSearchError(outcome);
      }
      if (name === WEB_FETCH_TOOL) {
        const url = typeof args.url === 'string' ? args.url : '';
        const outcome = await client.fetchPage(url);
        return outcome.ok ? renderFetchResult(outcome) : renderFetchError(outcome);
      }
      return `Error: unknown tool ${name}`;
    },
  };
}
