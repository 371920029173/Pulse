/**
 * 联网：一个搜索源表 + 一次取页。这里只做「发出去、读回来、认出来」，不碰工具层。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 缺的是什么
 *
 * 这个仓库的工具表里原本**没有任何联网工具**（枚举过全部注册名），机器上装的 MCP 里也没有搜索
 * 服务器 —— 唯一的 `fetch` 只暴露 `imageFetch`。所以「让 Agent 自己去网上查一下」这件事没有一条
 * 路能走：模型要么说"我查不到"，要么用 `shell` + `curl` 把一坨原始 HTML 塞进上下文（要开"允许
 * 所有命令"，而且没有解析、没有来源标注、没有去重）。
 *
 * 这里补上那一层，并且刻意分成两半：
 *
 *   - `web_search`：关键词 → 若干条 `{标题, 网址, 摘要}`。摘要**是线索不是答案**。
 *   - `web_fetch`：一个网址 → 正文（截断、去标签、带最终地址）。要读内容才有内容。
 *
 * 两半都要有，理由是不对称的：只有搜索，模型会把摘要当事实引用；只有取页，它得先知道网址。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么有免 key 的源，为什么默认是 `auto`
 *
 * 免 key 的源（DuckDuckGo 轻量页 / Bing 结果页）是**网页解析**，不是官方 API：对方改一次版式
 * 就会失效。这是真实代价，不藏着 —— 所以这里的失效一律判成"响应认不出来"（响亮、可见），
 * **绝不**落成"没搜到"。后者会被读成"网上没有这件事"，是最坏的一种假象。
 *
 * 默认 `auto` 不是"随便挑一个"，而是实测逼出来的：这台机器上 `duckduckgo.com` 与
 * `api.search.brave.com` 都**连不上**（超时，而 `example.com` 通），`www.bing.com` 通。一个写死的
 * 免 key 默认源，在写下它的那台机器上就可能是坏的 —— 那是「机制可用但默认关着」的镜像版本。
 * 所以 `auto` 依次试免 key 的源，用先答上来的那个，并在结果里点名是谁答的；连不上的源记在进程内，
 * 十分钟内不再白等（和 `resolveWslIsolation` 对 `wsl.exe` 的探测缓存同一个做法）。
 *
 * 带 key 的源（Tavily）与自建实例（SearXNG）只能是**显式**选择：auto 不会替你花那份钱，也不会
 * 猜一个你没配的地址。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 这台机器上的边界（说清楚，免得被读成比实际更严）
 *
 *   - 私网/回环地址在**字面上**被拒（`localhost`、`127.`、`10.`、`192.168.`、`::1` …），且每一跳
 *     重定向都重新过一遍这道判定。**但**它是一个只看字面主机名的规则：一个公网域名解析到内网 IP
 *     （DNS rebinding）它挡不住 —— 那需要真正解析 DNS 再比对，而解析本身又是一次出网。这条缺口
 *     写在这里，是因为把它说成"已防 SSRF"会让读者据此下错误的结论。
 *   - 只读文本类内容（html / 纯文本 / json / xml / markdown / csv）。PDF、图片、二进制一律拒绝并
 *     说明类型，不猜、不塞进上下文。
 *   - 页面**截断**而不报错：字节与字符两个上限，截断就在结果里明说截断了多少。一个几百 KB 的页面
 *     按 3.47 字符/token 折算也远超一轮的预算，"读完了"和"读了开头"必须能分开。
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createLogger } from '@she/shared';

const log = createLogger('web');

/** 配置里能写的档位。`auto` 见文件头；它只试免 key 的源。 */
export type WebProvider = 'off' | 'auto' | 'duckduckgo' | 'bing' | 'tavily' | 'searxng';
/** 真正会去请求的源（`off` / `auto` 不是源，是选择方式）。 */
export type WebSource = Exclude<WebProvider, 'off' | 'auto'>;

export interface WebConfig {
  provider: WebProvider;
  apiKey: string;
  baseUrl: string;
  maxResults: number;
  timeoutMs: number;
  maxFetchBytes: number;
}

/** 与 `config.ts` 的 DEFAULTS 同一份取值；分开写是因为工具与测试都可能只拿到半份配置。 */
export const WEB_DEFAULTS: WebConfig = {
  provider: 'auto',
  apiKey: '',
  baseUrl: '',
  maxResults: 5,
  timeoutMs: 15_000,
  maxFetchBytes: 512 * 1024,
};

const PROVIDERS: readonly WebProvider[] = ['off', 'auto', 'duckduckgo', 'bing', 'tavily', 'searxng'];

/**
 * 收一份可能是 undefined / 半份 / 夹着错值的配置，给出一份能用的。
 *
 * 认不出的档位退回默认（`auto`）而不是猜一个源：拼错一个源名就静默变成"另一个源在答"，比报错更
 * 难查。数值一律夹到有意义的区间里 —— `maxResults: 0` 会让工具看起来"搜了但什么都没有"，那是
 * 最像"网上没有这件事"的一种假象。
 */
export function resolveWebConfig(raw: Partial<WebConfig> | undefined): WebConfig {
  const src = raw ?? {};
  const provider = PROVIDERS.includes(src.provider as WebProvider) ? src.provider as WebProvider : WEB_DEFAULTS.provider;
  const n = (v: unknown, fallback: number, lo: number, hi: number): number => {
    const num = Number(v);
    if (!Number.isFinite(num) || num < lo) return fallback;
    return Math.min(Math.trunc(num), hi);
  };
  return {
    provider,
    apiKey: typeof src.apiKey === 'string' ? src.apiKey.trim() : WEB_DEFAULTS.apiKey,
    baseUrl: typeof src.baseUrl === 'string' ? src.baseUrl.trim().replace(/\/+$/, '') : WEB_DEFAULTS.baseUrl,
    maxResults: n(src.maxResults, WEB_DEFAULTS.maxResults, 1, 20),
    timeoutMs: n(src.timeoutMs, WEB_DEFAULTS.timeoutMs, 1_000, 120_000),
    maxFetchBytes: n(src.maxFetchBytes, WEB_DEFAULTS.maxFetchBytes, 4 * 1024, 8 * 1024 * 1024),
  };
}

export const SOURCE_SHORT: Record<WebSource, string> = {
  duckduckgo: 'DuckDuckGo',
  bing: 'Bing',
  tavily: 'Tavily',
  searxng: 'SearXNG',
};

/** 工具描述里写的那一句「在用的是哪一个」。写给人看，所以带上"怎么来的"。 */
export const SOURCE_LABELS: Record<WebSource, string> = {
  duckduckgo: 'DuckDuckGo 轻量结果页（免 key，靠解析网页）',
  bing: 'Bing 结果页（免 key，靠解析网页）',
  tavily: 'Tavily（需要 API key，返回已清洗的摘要）',
  searxng: 'SearXNG 自建实例（需要 baseUrl）',
};

/** `auto` 的尝试顺序：只有免 key 的两个。带 key 的源不会被自动选中（不能替用户花钱）。 */
export const AUTO_ORDER: readonly WebSource[] = ['duckduckgo', 'bing'];

/** 各源的默认地址。`baseUrl` 填了就覆盖（自建代理 / 自建实例）。 */
export const ENDPOINTS: Record<WebSource, string> = {
  duckduckgo: 'https://lite.duckduckgo.com/lite/',
  bing: 'https://www.bing.com/search',
  tavily: 'https://api.tavily.com/search',
  searxng: '',
};

/**
 * 自报身份的 UA，用爬虫的惯用格式（`Mozilla/5.0 (compatible; …)`）。
 *
 * 不伪装成浏览器：这是一台本地 Agent 在替用户查资料，对方要封就该封得掉。同时这个前缀是各家
 * 简单机器人过滤看一眼就放行的写法 —— 实测 Bing 用 `SHE-Agent/0.3` 也照常返回结果，所以这里
 * 并不是靠伪装换来的可用性。
 */
export const USER_AGENT = 'Mozilla/5.0 (compatible; SHE-Agent; +local-agent)';

/** 一条结果的摘要上限。摘要是线索，不是正文 —— 正文用 `web_fetch`。 */
export const SNIPPET_CHARS = 320;

/** 交付给模型的正文上限（字符，不是字节）。超过就截断并说明。 */
export const MAX_PAGE_CHARS = 20_000;

/** 最多跟几跳重定向。每一跳都要重新过私网判定。 */
export const MAX_REDIRECTS = 3;

export interface WebHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * 一次搜索的结局。
 *
 * `hits: []` 与"失败"是两种东西，所以分成两支：`ok: true` 且没有命中 = **问过了，网上没有**；
 * 出错了 = 没问到。把后者写成前者，就是"我查了，网上没这件事"这句假话的产生方式。
 */
/**
 * 一次搜索里"问了但没答上来"的源。
 *
 * 和 `skipped`（这次**没问**，因为十分钟内记着它连不上）是两件事，所以两个字段而不是一个：
 * "跳过了"和"问了没答"对读者的含义不同 —— 前者说明这次的结果少了哪个引擎的视角，后者还带着
 * 症状（超时 / 503 / 限流），是能拿来判断"要不要换源"的证据。
 */
export interface WebMiss {
  source: WebSource;
  kind: WebFailureKind;
  detail: string;
}

export type SearchOutcome =
  | {
    ok: true;
    hits: WebHit[];
    query: string;
    source: WebSource;
    via: 'auto' | 'explicit';
    /** 这一次实际问过的源（含答上来的那个），按问的顺序。 */
    tried: WebSource[];
    /** 这一次问了但没答上来的源。 */
    missed: WebMiss[];
    /** 这一次根本没问的源（进程内的"十分钟内不再试它"记忆）。 */
    skipped: WebSource[];
  }
  | { ok: false; kind: WebFailureKind; detail: string; tried: WebSource[]; missed: WebMiss[]; skipped?: WebSource[] };

export type WebFailureKind =
  /** 用户把联网关了（`SHE_WEB_PROVIDER=off`）。 */
  | 'off'
  /** 参数本身不对：空 query、非 http(s) 的地址、内容类型读不了。 */
  | 'invalid_args'
  /** 目标指向本机/内网：边界按设计拒绝，不是参数写错。 */
  | 'blocked_host'
  /** 超时（可重试）。 */
  | 'timeout'
  /** 429（可重试，但别紧凑重试）。 */
  | 'rate_limited'
  /** 连不上 / 5xx / 响应读不出来。 */
  | 'service'
  /** 401 / 403：key 不对或对方拒绝（要人决定）。 */
  | 'auth'
  /** 404 / 410：这个地址没有东西。 */
  | 'not_found'
  /** 内容类型不在可读范围内（PDF/图片/二进制）。 */
  | 'content_type';

export type FetchOutcome =
  | {
    ok: true;
    /** 最终地址（跟完重定向之后）。 */
    url: string;
    /** 请求的地址。两者不同就说明跟过跳转。 */
    requested: string;
    hops: string[];
    status: number;
    contentType: string;
    title: string;
    text: string;
    bytes: number;
    /** 因为超过字节上限而没读完。 */
    truncatedBytes: boolean;
    /** 因为超过字符上限而截断。 */
    truncatedChars: boolean;
  }
  | { ok: false; kind: WebFailureKind; detail: string; redirected?: string[] };

/* ══════════════════════════════════════════════════════════════════════════
 * 文本处理：实体、标签、正文
 *
 * 这些是纯函数，也是整个模块里最容易悄悄错掉的地方（一个实体解不出来就是一段乱码进入上下文），
 * 所以它们和网络分开写、单独测。
 * ══════════════════════════════════════════════════════════════════════════ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', hellip: '\u2026',
  mdash: '\u2014', ndash: '\u2013', middot: '\u00b7', bull: '\u2022',
  rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
  times: '\u00d7', divide: '\u00f7', deg: '\u00b0', plusmn: '\u00b1',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', sect: '\u00a7', para: '\u00b6',
  laquo: '\u00ab', raquo: '\u00bb', szlig: '\u00df', frac12: '\u00bd',
  larr: '\u2190', rarr: '\u2192', harr: '\u2194', darr: '\u2193', uarr: '\u2191',
};

/**
 * 解 HTML 实体。数字实体（`&#183;` / `&#x27;`，含前导零的 `&#0183;`）与常见具名实体。
 *
 * 认不出来的一律**原样保留**：把未知实体吞掉会把 `&foo;` 变成空串，而"少了一段字"比"多了一串
 * 原样的字符"更难发现。
 */
export function decodeEntities(input: string): string {
  return String(input ?? '').replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/*
 * 标签不是"词与词之间的空白"。
 *
 * 第一版是 `replace(/<[^>]*>/g, ' ')`，于是 `Type<strong>Script</strong> docs` 读成
 * `Type Script · docs` —— 搜索引擎给关键词加 `<strong>`/`<b>` 高亮是**常态**，所以这会把结果
 * 标题里的词一个个劈开。判据是标签的**性质**：块级标签真的分隔内容（`<li>a</li><li>b</li>` 是两
 * 项），必须留一个边界；行内标签只是样式（`<strong>`/`<em>`/`<span>`/`<a>`），去掉即可，
 * 留着边界反而是在正文里插了本来没有的空格。
 */
const LINE_BREAK_TAGS = /<\/?(?:p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol|dl|dt|dd|nav|main|aside|figure|figcaption|fieldset|address|br|hr)\b[^>]*\/?>/gi;

/** 去标签 + 解实体 + 压空白。用于标题、摘要这类单行文本。 */
export function cleanText(input: string): string {
  const noTags = String(input ?? '').replace(LINE_BREAK_TAGS, '\n').replace(/<[^>]*>/g, '');
  return decodeEntities(noTags).replace(/[\s\u00a0]+/g, ' ').trim();
}

/** 连正文一起丢掉的东西：脚本、样式、以及各种不是给人读的容器。 */
const DROP_BLOCKS = /<(script|style|noscript|template|svg|iframe|object|embed|canvas|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/*
 * `<title>` 单独一条，理由和上面那组不同：标题是**元数据**，已经由 `extractTitle` 取走、放在结果的
 * 第一行。留在正文里只会多出一句"页面标题 正文第一段。"，让模型以为标题是正文的开头。
 */
const HEAD_TITLE = /<title\b[^>]*>[\s\S]*?<\/title\s*>/gi;

/** 这些闭合标签之后要有一次换行，否则整页会被压成一行（也就没法按段落引用了）。 */
const BLOCK_ENDS = /<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre|table|ul|ol|dl|dt|dd|nav|main|aside|figure|figcaption|fieldset|address)\s*>/gi;

/**
 * HTML → 纯文本。
 *
 * 顺序是有讲究的：先丢整块（脚本内容不能参与后面的去标签），再把块级闭合标签换成换行（否则整页
 * 一行），然后才去标签、**再**解实体 —— 反过来的话，页面里写成 `&lt;script&gt;` 的正常文本会被
 * 当成真的脚本块删掉。
 */
export function htmlToText(html: string): string {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(DROP_BLOCKS, ' ');
  s = s.replace(HEAD_TITLE, '\n');
  s = s.replace(/<(?:br|hr)\b[^>]*\/?>/gi, '\n');
  s = s.replace(BLOCK_ENDS, '\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/\r\n?/g, '\n');
  s = s.split('\n').map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 页面的标题：`<title>` 优先，没有就第一个 `<h1>`。 */
export function extractTitle(html: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(String(html ?? ''));
  if (title) {
    const cleaned = cleanText(title[1]);
    if (cleaned) return cleaned;
  }
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(String(html ?? ''));
  return h1 ? cleanText(h1[1]) : '';
}

/* ══════════════════════════════════════════════════════════════════════════
 * 结果页解析：每个源一个函数，全部是纯的
 * ══════════════════════════════════════════════════════════════════════════ */

/** DuckDuckGo 的跳转壳 `//duckduckgo.com/l/?uddg=<encoded>`：真正的地址在里面。 */
function unwrapDuckDuckGoRedirect(href: string): string {
  const raw = String(href ?? '').trim();
  const m = /[?&]uddg=([^&]+)/.exec(raw);
  if (!m) return raw.startsWith('//') ? `https:${raw}` : raw;
  try { return decodeURIComponent(m[1]); } catch { return raw; }
}

/**
 * DuckDuckGo 轻量版（`lite.duckduckgo.com/lite/`）。
 *
 * 结构是表格：结果链接带 `class="result-link"`，摘要紧跟在后面的 `result-snippet` 单元格里。
 * 靠 class 名而不是靠位置，是因为页面上还有导航、广告、"相关搜索"这些同形状的链接。
 *
 * 认不出来时返回空数组 —— **由调用方**去区分"页面说了没有结果"和"版式变了"（见
 * `looksLikeNoResults`）。这两件事在这里混成一件，就等于把版式变化报成"网上没有"。
 */
export function parseDuckDuckGoLite(html: string, limit: number): WebHit[] {
  const text = String(html ?? '');
  const hits: WebHit[] = [];
  const anchors = text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi);
  for (const anchor of anchors) {
    if (hits.length >= limit) break;
    const attrs = anchor[1] ?? '';
    if (!/class\s*=\s*["']?[^"'>]*result-link/i.test(attrs)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '';
    const url = unwrapDuckDuckGoRedirect(decodeEntities(href));
    if (!/^https?:\/\//i.test(url)) continue;
    const rest = text.slice((anchor.index ?? 0) + anchor[0].length);
    const snip = /result-snippet[^>]*>([\s\S]{0,1200}?)<\/(?:td|div|span)\s*>/i.exec(rest)?.[1] ?? '';
    hits.push({ title: cleanText(anchor[2]), url, snippet: cleanText(snip).slice(0, SNIPPET_CHARS) });
  }
  return hits;
}

/**
 * Bing 结果页（`www.bing.com/search`）。
 *
 * 每条结果是一个 `<li class="b_algo">`：标题在它里面的第一个 `<h2><a href=…>`，摘要在
 * `b_caption` 的 `<p>` 里。切块而不是全局抓 `<h2>`，是因为 `b_algo` 之外的 `h2`（"相关搜索"、
 * "人们还问"）也长一个样。
 */
export function parseBing(html: string, limit: number): WebHit[] {
  const text = String(html ?? '');
  const hits: WebHit[] = [];
  const blocks = text.split(/<li\b[^>]*class\s*=\s*["'][^"']*\bb_algo\b[^"']*["'][^>]*>/i).slice(1);
  for (const block of blocks) {
    if (hits.length >= limit) break;
    const body = block.slice(0, 20_000);
    const head = /<h2\b[^>]*>[\s\S]*?<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>[\s\S]*?<\/h2\s*>/i.exec(body);
    if (!head) continue;
    const url = decodeEntities(head[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const caption = /class\s*=\s*["'][^"']*\bb_caption\b[^"']*["'][\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p\s*>/i.exec(body)?.[1]
      ?? /class\s*=\s*["'][^"']*\bb_caption\b[^"']*["'][\s\S]*?<\/div\s*>/i.exec(body)?.[0]
      ?? '';
    hits.push({ title: cleanText(head[2]), url, snippet: cleanText(caption).slice(0, SNIPPET_CHARS) });
  }
  return hits;
}

/** `{ results: [{ title, url, content|snippet|description }] }` —— Tavily 与 SearXNG 共用的形状。 */
function parseJsonResults(json: unknown, limit: number): WebHit[] {
  const list = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(list)) return [];
  const hits: WebHit[] = [];
  for (const item of list) {
    if (hits.length >= limit) break;
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const url = String(row.url ?? row.link ?? '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const body = row.content ?? row.snippet ?? row.description ?? row.text ?? '';
    hits.push({
      title: cleanText(String(row.title ?? row.heading ?? url)),
      url,
      snippet: cleanText(String(body)).slice(0, SNIPPET_CHARS),
    });
  }
  return hits;
}

export const parseTavily = parseJsonResults;
export const parseSearxng = parseJsonResults;

/** 页面自己说"没有结果"。用来把"真的没搜到"和"版式变了"分开。 */
export function looksLikeNoResults(body: string): boolean {
  return /no\s+results|没有找到|没有相关|找不到相关|没有任何结果|未找到相关/i.test(String(body ?? ''));
}

/** 把一段响应体按源解析成结果。三种结论：有命中 / 明确没有 / 认不出来。 */
export function parseSearchBody(
  source: WebSource,
  body: string,
  limit: number,
): { hits: WebHit[] } | { unreadable: true } | { none: true } {
  if (source === 'tavily' || source === 'searxng') {
    let json: unknown;
    try { json = JSON.parse(body); } catch { return { unreadable: true }; }
    if (!json || typeof json !== 'object' || !Array.isArray((json as { results?: unknown }).results)) {
      return { unreadable: true };
    }
    const hits = parseJsonResults(json, limit);
    return hits.length ? { hits } : { none: true };
  }
  const hits = source === 'bing' ? parseBing(body, limit) : parseDuckDuckGoLite(body, limit);
  if (hits.length) return { hits };
  // 没有命中且页面自己说了"没有结果" → 真的没有；否则是版式变了，必须说"认不出来"。
  return looksLikeNoResults(body) ? { none: true } : { unreadable: true };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 地址边界
 * ══════════════════════════════════════════════════════════════════════════ */

/** 名字一看就是本机/局域网的（含 `.internal` / `.lan` 这类内网后缀）。 */
const PRIVATE_NAME = /^(?:localhost|.+\.localhost|.+\.local|.+\.internal|.+\.lan|.+\.home\.arpa)$/i;

/**
 * 字面主机名是不是本机/内网。
 *
 * 只看字面，**不解析 DNS** —— 解析本身是一次出网，而且结果会变。代价写在文件头：一个公网域名
 * 解析到内网 IP 挡不住。收在这里是因为它挡的是最常见的那种"搜索结果的跳转把你带回本机服务"。
 */
export function isPrivateHost(hostname: string): boolean {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (PRIVATE_NAME.test(host)) return true;
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true;
  // IPv6：唯一本地地址 fc00::/7，链路本地 fe80::/10。
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 0 || a === 10 || a === 127) return true;          // 本机 / 私有
  if (a === 169 && b === 254) return true;                      // 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true;             // 私有
  if (a === 192 && b === 168) return true;                      // 私有
  if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT
  if (a >= 224) return true;                                    // 组播 / 保留
  return false;
}

export type UrlGuard = { ok: true; url: URL } | { ok: false; kind: 'invalid_args' | 'blocked_host'; detail: string };

/**
 * 这次取页的地址能不能去。
 *
 * 没有 scheme 时补 `https://`（模型经常只给 `example.com/page`，为这个报错没有价值），补过就是
 * 结果里的事实 —— `web_fetch` 会说它实际请求的是哪个地址。
 */
export function assertFetchableUrl(raw: string): UrlGuard {
  const text = String(raw ?? '').trim().replace(/^<|>$/g, '');
  if (!text) return { ok: false, kind: 'invalid_args', detail: '没有给地址' };
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try { url = new URL(withScheme); } catch { return { ok: false, kind: 'invalid_args', detail: '认不出这个地址' }; }
  const scheme = url.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    return { ok: false, kind: 'invalid_args', detail: `只支持 http/https，收到 ${scheme}` };
  }
  if (url.username || url.password) {
    return { ok: false, kind: 'invalid_args', detail: '地址里不要带用户名密码' };
  }
  if (isPrivateHost(url.hostname)) return { ok: false, kind: 'blocked_host', detail: url.hostname };
  return { ok: true, url };
}

/** 可读的内容类型。别的（PDF、图片、压缩包、二进制）一律拒绝，不猜。 */
export function classifyContentType(contentType: string): 'html' | 'text' | 'other' {
  const type = String(contentType ?? '').toLowerCase().split(';')[0].trim();
  if (!type) return 'text'; // 没声明就按文本试一次：总比什么都不读好，而且结果里会写出这个假设
  if (type === 'text/html' || type === 'application/xhtml+xml' || type === 'text/xml' || type === 'application/xml') return 'html';
  if (type.startsWith('text/')) return 'text';
  if (type === 'application/json' || type === 'application/ld+json' || type.endsWith('+json')) return 'text';
  if (type === 'application/x-yaml' || type === 'application/yaml') return 'text';
  return 'other';
}

/* ══════════════════════════════════════════════════════════════════════════
 * 请求
 * ══════════════════════════════════════════════════════════════════════════ */

interface SearchRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

/** 拼一次搜索请求。纯函数：给定源与配置，请求就该是确定的 —— 这样它能被离线断言。 */
export function buildSearchRequest(
  source: WebSource,
  cfg: WebConfig,
  query: string,
  limit: number,
): { ok: true; request: SearchRequest } | { ok: false; detail: string } {
  const base = cfg.baseUrl || ENDPOINTS[source];
  if (!base) return { ok: false, detail: `${SOURCE_SHORT[source]} 需要 baseUrl（自建实例地址）` };
  const q = encodeURIComponent(query);
  switch (source) {
    case 'duckduckgo':
      return { ok: true, request: { url: `${base}?q=${q}`, method: 'GET', headers: { accept: 'text/html,application/xhtml+xml' } } };
    case 'bing':
      // `count` 让结果条数和 limit 对齐（Bing 默认 10 条，可能整页都是广告位）。
      return { ok: true, request: { url: `${base}?q=${q}&count=${Math.max(limit, 5)}`, method: 'GET', headers: { accept: 'text/html,application/xhtml+xml' } } };
    case 'tavily':
      if (!cfg.apiKey) return { ok: false, detail: `${SOURCE_SHORT.tavily} 需要 API key（SHE_WEB_API_KEY）` };
      return {
        ok: true,
        request: {
          url: base,
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ query, max_results: limit, search_depth: 'basic', include_answer: false, include_raw_content: false }),
        },
      };
    case 'searxng':
      return { ok: true, request: { url: `${base}/search?q=${q}&format=json`, method: 'GET', headers: { accept: 'application/json' } } };
  }
}

interface Attempt {
  source: WebSource;
  hits?: WebHit[];
  kind?: WebFailureKind;
  detail?: string;
}

/**
 * 聚合失败该报哪一类 —— 用**和分类器同一张顺序表**推，而不是"最后一个源的那类"。
 *
 * 两个理由：
 *
 *   1. 取最后一个，等于让尝试顺序决定类别。`auto` 的顺序是配置的实现细节，不该决定报告给模型/
 *      错题本的失败原因。
 *   2. `renderSearchError` 会把每个源的**症状原文**写进同一句话，而 `tool-result.ts` 是在这句话
 *      上按固定顺序（timeout → rate_limited → service → …）找第一个命中的症状。所以聚合时的判定
 *      必须用同一张表，文本和判定才不会打架 —— 离线单测抓到过这个：一个源超时、另一个源 503，
 *      期望 service，实际被那句"超时（15000ms）"读成 timeout。
 *
 * 表里只留聚合真能出现的类别：`auth` / `invalid_args` 一出现就整条返回（见 `search`），
 * `off` / `blocked_host` 在搜索这条路上不可达（源地址来自配置，不过私网判定）。
 */
const KIND_PRIORITY: readonly WebFailureKind[] = ['timeout', 'rate_limited', 'service', 'invalid_args', 'not_found'];

function aggregateKind(attempts: Attempt[]): WebFailureKind {
  for (const kind of KIND_PRIORITY) {
    if (attempts.some((a) => a.kind === kind)) return kind;
  }
  // 走到这里说明每个 attempt 都没有 kind（既没命中也没失败），只能按"说不清"报。
  return 'service';
}

/** 这一次问了但没答上来的源（带症状），给结果文案用。 */
function missesOf(attempts: Attempt[]): WebMiss[] {
  return attempts.flatMap((a) => (a.kind ? [{ source: a.source, kind: a.kind, detail: a.detail ?? '失败' }] : []));
}

export interface WebDeps {
  /** 注入点：测试与离线门禁用一个桩 fetch，不发真请求。 */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** 连不上的源记多久。太短（每次调用都白等一次超时）和太长（一次抖动记成永久故障）都要避免。 */
const DOWN_TTL_MS = 10 * 60_000;

/**
 * 联网客户端。一个实例持有配置与"哪些源连不上"的记忆。
 *
 * 记忆放在实例里而不是模块级：门禁的每一段都用新实例，于是段落之间不会互相影响，而一个长跑进程
 * 里这份记忆是真的有用的（第一次调用知道 DDG 不通之后，后面每次都不用再等那 15 秒）。
 */
export class WebClient {
  private readonly cfg: WebConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly down = new Map<WebSource, number>();

  constructor(cfg: Partial<WebConfig> | undefined, deps: WebDeps = {}) {
    this.cfg = resolveWebConfig(cfg);
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  get config(): WebConfig { return this.cfg; }

  /** 工具描述里那句话的来源：现在是哪一档、哪一个源在答。 */
  describe(): string {
    if (this.cfg.provider === 'off') return '联网已关闭（SHE_WEB_PROVIDER=off）。';
    if (this.cfg.provider === 'auto') {
      return '搜索源：自动 —— 依次试 ' + AUTO_ORDER.map((s) => SOURCE_SHORT[s]).join('、')
        + '，用先答上来的那个，每条结果里点名是谁答的。';
    }
    return `搜索源：${SOURCE_LABELS[this.cfg.provider]}`;
  }

  /** 现在还会去试的源（`auto` 用）。全都被记下来了就把顺序原样返回：宁可再试一次，也不空手拒绝。 */
  private autoSources(): { order: WebSource[]; skipped: WebSource[] } {
    const at = this.now();
    const live = AUTO_ORDER.filter((s) => (this.down.get(s) ?? 0) <= at);
    const skipped = AUTO_ORDER.filter((s) => (this.down.get(s) ?? 0) > at);
    return { order: live.length ? live : [...AUTO_ORDER], skipped: live.length ? skipped : [] };
  }

  private rememberDown(source: WebSource, kind: WebFailureKind): void {
    if (kind !== 'timeout' && kind !== 'service') return;
    this.down.set(source, this.now() + DOWN_TTL_MS);
    log.info(`搜索源 ${source} 这次${kind === 'timeout' ? '超时' : '连不上'}，${DOWN_TTL_MS / 60_000} 分钟内不再试它`);
  }

  private transportFailure(err: unknown): { kind: WebFailureKind; detail: string } {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError' || /timed?\s*out|timeout|abort/i.test(message)) {
      return { kind: 'timeout', detail: `超时（${this.cfg.timeoutMs}ms）` };
    }
    return { kind: 'service', detail: `请求失败：${message}` };
  }

  /** HTTP 状态 → 类别。四类给四条不同的去路，这是看状态码的**唯一**理由。 */
  static kindForStatus(status: number): WebFailureKind {
    if (status === 429) return 'rate_limited';
    if (status === 408 || status === 504) return 'timeout';
    if (status >= 500) return 'service';
    if (status === 401 || status === 403) return 'auth';
    if (status === 404 || status === 410) return 'not_found';
    return 'invalid_args';
  }

  private static readonly STATUS_TEXT: Record<number, string> = {
    400: '对方说这个请求不对',
    401: '需要凭据（API key 没配或不对）',
    403: '对方拒绝了这次请求（可能是反爬或需要登录）',
    404: '没有这个地址',
    408: '对方等超时了',
    410: '这个地址已经失效',
    429: '被限流',
    500: '对方内部错误',
    502: '对方的网关出错',
    503: '对方暂时不可用',
    504: '对方的网关超时',
  };

  private statusFailure(status: number): { kind: WebFailureKind; detail: string } {
    const text = WebClient.STATUS_TEXT[status] ?? '';
    return { kind: WebClient.kindForStatus(status), detail: `HTTP ${status}${text ? `（${text}）` : ''}` };
  }

  /**
   * `auto` 只会试免 key 的源；这里显式指定的失败就直接是失败 —— **不偷偷换一个**。换源会改变结果的
   * 来源，而来源是用户能核对的东西（描述与结果里都点名），悄悄换掉等于把一句可核对的话变成不可核对。
   *
   * 源地址**不过**私网判定：`baseUrl` 指向本机的自建 SearXNG 是合法用法，那是用户自己的配置。
   * 私网那道边界只加在 `web_fetch` 上 —— 它跟的是**网页内容给的**地址，方向才是"别被带回本机"。
   */
  async search(query: string): Promise<SearchOutcome> {
    const q = String(query ?? '').trim();
    if (!q) return { ok: false, kind: 'invalid_args', detail: 'query 是空的', tried: [], missed: [] };
    if (this.cfg.provider === 'off') return { ok: false, kind: 'off', detail: 'SHE_WEB_PROVIDER=off', tried: [], missed: [] };

    const explicit = this.cfg.provider !== 'auto';
    const { order, skipped } = explicit
      ? { order: [this.cfg.provider as WebSource], skipped: [] as WebSource[] }
      : this.autoSources();

    const attempts: Attempt[] = [];
    for (const source of order) {
      const attempt = await this.searchOne(source, q);
      attempts.push(attempt);

      if (attempt.hits && attempt.hits.length) {
        return {
          ok: true, hits: attempt.hits, query: q, source,
          via: explicit ? 'explicit' : 'auto',
          tried: attempts.map((a) => a.source), missed: missesOf(attempts), skipped,
        };
      }
      /*
       * 参数/凭据层面的错不会因为换一个源就好 —— 继续试只会把一条清楚的错误埋进一串失败里。
       */
      if (attempt.kind === 'invalid_args' || attempt.kind === 'auth') {
        return { ok: false, kind: attempt.kind, detail: attempt.detail ?? '', tried: attempts.map((a) => a.source), missed: missesOf(attempts), skipped };
      }
      if (attempt.hits && !attempt.hits.length) {
        // 这个源明确说"没有结果"。显式的源到此为止；auto 继续问下一个（不同引擎的结果不同，
        // 而且"两个引擎都说没有"比"一个引擎说没有"更接近"网上没有这件事"）。
        if (explicit) {
          return { ok: true, hits: [], query: q, source, via: 'explicit', tried: [source], missed: [], skipped };
        }
        continue;
      }
      this.rememberDown(source, attempt.kind ?? 'service');
    }

    if (attempts.length && attempts.every((a) => a.hits && !a.hits.length)) {
      const last = attempts[attempts.length - 1];
      // "问了，网上没有"是答案不是失败，所以 `missed` 为空：这里的每个源都答上了话，只是内容为空。
      return { ok: true, hits: [], query: q, source: last.source, via: 'auto', tried: attempts.map((a) => a.source), missed: [], skipped };
    }
    /*
     * 混合失败（一部分源答"没有结果"、一部分源连不上）走到这里报失败，而不是报"网上没有"：少问了一个
     * 引擎的时候，"网上没有"这句话没有证据。但那个**答上话**的源不能写成"失败" —— 它说的话是
     * "没搜到"，这是有效回答，所以它的症状单独写成一句。
     */
    const symptom = (a: Attempt) => a.detail ?? (a.hits ? '这个源说没有结果' : '失败');
    return {
      ok: false,
      kind: aggregateKind(attempts),
      detail: attempts.map((a) => `${SOURCE_SHORT[a.source]}：${symptom(a)}`).join('；'),
      tried: attempts.map((a) => a.source),
      missed: missesOf(attempts),
      skipped,
    };
  }

  private async searchOne(source: WebSource, query: string): Promise<Attempt> {
    const built = buildSearchRequest(source, this.cfg, query, this.cfg.maxResults);
    if (!built.ok) return { source, kind: 'auth', detail: built.detail };
    const { request } = built;
    let response: Response;
    try {
      response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: { ...request.headers, 'user-agent': USER_AGENT },
        body: request.body,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        redirect: 'follow',
      });
    } catch (err) {
      return { source, ...this.transportFailure(err) };
    }
    if (!response.ok) return { source, ...this.statusFailure(response.status) };
    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      return { source, kind: 'service', detail: `响应读不出来：${err instanceof Error ? err.message : String(err)}` };
    }
    const parsed = parseSearchBody(source, body, this.cfg.maxResults);
    if ('hits' in parsed) return { source, hits: parsed.hits };
    if ('none' in parsed) return { source, hits: [] };
    return { source, kind: 'service', detail: `${SOURCE_SHORT[source]} 的响应认不出来（对方接口可能改了）` };
  }

  /**
   * 取一个网页的正文。
   *
   * 重定向自己跟（`redirect: 'manual'`）：每一跳都要重新过一遍私网判定，否则一个公网地址用
   * 302 就能把这次读取指回本机服务 —— 那道字面判定就白写了。
   */
  async fetchPage(rawUrl: string): Promise<FetchOutcome> {
    const guard = assertFetchableUrl(rawUrl);
    if (!guard.ok) return { ok: false, kind: guard.kind, detail: guard.detail };

    const requested = guard.url.toString();
    let current = guard.url;
    const hops: string[] = [];

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response: Response;
      try {
        response = await this.fetchImpl(current.toString(), {
          method: 'GET',
          headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1' },
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
          redirect: 'manual',
        });
      } catch (err) {
        const failed = this.transportFailure(err);
        return { ok: false, ...failed, ...(hops.length ? { redirected: hops } : {}) };
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { ok: false, kind: 'service', detail: `HTTP ${response.status} 但没有 Location 头`, redirected: hops };
        if (hop === MAX_REDIRECTS) return { ok: false, kind: 'service', detail: `跳转超过 ${MAX_REDIRECTS} 次`, redirected: hops };
        let next: URL;
        try { next = new URL(location, current); } catch { return { ok: false, kind: 'invalid_args', detail: '跳转目标认不出来', redirected: hops }; }
        const nextGuard = assertFetchableUrl(next.toString());
        if (!nextGuard.ok) {
          return { ok: false, kind: nextGuard.kind, detail: `${nextGuard.detail}（跳转目标）`, redirected: [...hops, next.toString()] };
        }
        hops.push(next.toString());
        current = next;
        continue;
      }

      if (!response.ok) return { ok: false, ...this.statusFailure(response.status), ...(hops.length ? { redirected: hops } : {}) };

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const shape = classifyContentType(contentType);
      if (shape === 'other') {
        return { ok: false, kind: 'content_type', detail: contentType || '（没有声明类型）', redirected: hops };
      }

      const read = await readCapped(response, this.cfg.maxFetchBytes);
      const full = shape === 'html' ? htmlToText(read.text) : read.text.trim();
      const truncatedChars = full.length > MAX_PAGE_CHARS;
      return {
        ok: true,
        url: current.toString(),
        requested,
        hops,
        status: response.status,
        contentType: contentType || '（没有声明）',
        title: shape === 'html' ? extractTitle(read.text) : '',
        text: truncatedChars ? full.slice(0, MAX_PAGE_CHARS) : full,
        bytes: read.bytes,
        truncatedBytes: read.truncated,
        truncatedChars,
      };
    }
    // 循环必然在上面 return，这一行只是让类型完备。
    return { ok: false, kind: 'service', detail: '跳转处理异常' };
  }
}

/**
 * 读到字节上限就停。
 *
 * 不用 `response.text()`：那会先把整个响应读进内存，一个几百 MB 的地址就能把进程拖垮 —— 而
 * "不要相信对端"正是这道上限存在的理由。读满了就 cancel 掉 reader，明确断掉连接而不是继续下载。
 */
export async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = response.body;
  if (!body) {
    const text = await response.text().catch(() => '');
    const bytes = Buffer.byteLength(text, 'utf8');
    return { text, bytes, truncated: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      const room = maxBytes - bytes;
      if (value.length >= room) {
        chunks.push(value.subarray(0, Math.max(room, 0)));
        bytes += Math.max(room, 0);
        truncated = true;
        break;
      }
      chunks.push(value);
      bytes += value.length;
    }
  } catch {
    /*
     * 读到一半断了：把已经拿到的留下。
     *
     * 这和 provider 流式读取同一条理由 —— 已经到手的内容是真的，丢掉它去报一个连接错误，读者会
     * 以为什么都没读到。截断说明会在结果里如实写出来。
     */
    truncated = true;
  } finally {
    try { await reader.cancel(); } catch { /* 已经结束 */ }
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), bytes, truncated };
}
