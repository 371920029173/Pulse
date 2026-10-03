/**
 * Query understanding for the group-structure retrieval — deterministic, offline, explainable.
 *
 * Measured on a live library: a query that states only the MEANING ("程序出错后如何避免重蹈覆辙
 * 记录犯过的错") returned five unrelated nodes and nothing from `errors/`, while the same library
 * answered "错题本 errorbook 失败记录" perfectly. The retrieval was lexical at every entry point:
 * BM25 over node text, group anchors over Latin path segments. Three things were missing, and all
 * three are fixed here WITHOUT embeddings (the project's hard rule — see CONTRIBUTING.md):
 *
 *   1. CJK query noise. Bigrams are generated mechanically, so "如何", "后如", "的错" became query
 *      terms and matched whatever happened to share them. `queryTerms` drops function-word bigrams
 *      from the QUERY only (the index is untouched, so nothing already findable becomes unfindable).
 *   2. No bridge between how a thing is ASKED and how it is WRITTEN. The error book writes
 *      "失败类型 / 教训"; people ask about "犯过的错 / 踩坑 / mistakes". `CONCEPTS` is a small,
 *      curated, bilingual concept map for the system's own vocabulary. A query that names a concept
 *      in any of its words is expanded with the concept's other words, at a lower weight, and the
 *      trace says which word carried it ("via 犯过的错→mistake").
 *   3. Groups had no vocabulary. A group is only its name; `errors` and `自省` could not be reached
 *      by a query in other words. `groupConcepts` derives each group's concepts from its name, its
 *      ancestors' names and its members' titles, so retrieval can ROUTE a query to a group before
 *      scoring nodes — the structural half of the fix.
 *
 * Everything here is a pure function of text: no model call, no network, same answer every time.
 */

/** A concept of the system's own vocabulary, and the words it is asked and written in. */
export interface Concept {
  id: string;
  /** Words and phrases, Chinese and English, lower-case. Latin entries match whole words. */
  terms: string[];
}

/**
 * The concept map. Deliberately small and about THIS system (its error book, plans, reflection,
 * sandbox, KB) — a general thesaurus would expand everything into everything, which is noise.
 * Adding a concept: keep it to words that a user would plausibly use for the SAME thing.
 */
export const CONCEPTS: Concept[] = [
  {
    id: 'mistake',
    terms: [
      '错题本', '错误', '出错', '犯错', '犯过的错', '重蹈覆辙', '踩坑', '踩过', '坑', '教训', '失败', '报错',
      '故障', '翻车', '失误', '前车之鉴',
      'errorbook', 'error', 'errors', 'mistake', 'mistakes', 'failure', 'failures', 'failed', 'went wrong',
      'pitfall', 'pitfalls', 'lesson', 'lessons', 'gotcha', 'gotchas',
    ],
  },
  {
    id: 'reflection',
    terms: ['自省', '反思', '自我反思', '复盘', '习惯', '漂移', '过度自信', '自检',
      'reflection', 'self-reflection', 'reflect', 'retrospective', 'habit', 'habits', 'drift', 'overconfident'],
  },
  {
    id: 'not_found',
    terms: ['不存在', '找不到', '没找到', '缺失', '不见了', 'not found', 'not_found', 'missing', 'enoent',
      'no such file', 'does not exist', "doesn't exist"],
  },
  {
    id: 'permission',
    terms: ['拒绝', '被拒', '权限', '越界', '工作区外', '禁止', 'denied', 'permission', 'forbidden', 'refused',
      'outside the workspace', 'not allowed', 'escape'],
  },
  {
    id: 'shell',
    terms: ['命令行', '终端', '命令', '控制台', 'shell', 'cmd', 'powershell', 'bash', 'terminal', 'command line',
      'console', 'command'],
  },
  {
    id: 'not_recognized',
    terms: ['不可用', '无法识别', '不是内部或外部命令', '没有这个命令', 'not recognized', 'is not recognized',
      'command not found', 'unavailable'],
  },
  {
    id: 'encoding',
    terms: ['乱码', '编码', '字符集', '看不懂的字符', '奇怪的字符', '代码页', 'gbk', 'utf-8', 'utf8', 'encoding', 'garbled',
      'mojibake', 'bom', 'charset', 'code page', 'codepage'],
  },
  {
    id: 'cost',
    terms: ['成本', '花费', '费用', '多少钱', '花了', '消耗', '计费', '账单', 'token', 'tokens', 'cost', 'costs',
      'spend', 'spent', 'expensive', 'price', 'billing', 'consume', 'consumed'],
  },
  {
    id: 'rubric',
    terms: ['评分', '打分', '分数', '口径', '评级', '总评', '标准', 'rubric', 'score', 'scoring', 'grade', 'grading',
      'rating'],
  },
  {
    id: 'plan',
    terms: ['计划', '步骤', '规划', '待办', 'plan', 'plans', 'step', 'steps', 'todo', 'roadmap', 'plan_update'],
  },
  {
    id: 'subagent',
    terms: ['子代理', '子智能体', '子任务', '子会话', '委派', 'subagent', 'sub agent', 'sub-agent', 'child agent',
      'task_spawn', 'delegate', 'delegation'],
  },
  {
    id: 'kb',
    terms: ['知识库', '组记忆', '记忆库', 'knowledge base', 'kb', 'memory', 'memories'],
  },
  {
    id: 'timeout',
    terms: ['超时', '卡住', '无响应', '一直没返回', 'timeout', 'timed out', 'time out', 'hang', 'hangs', 'stuck',
      'stuck_loop'],
  },
  {
    id: 'environment',
    terms: ['环境', '机器', '本机', '端口', '系统', 'environment', 'machine', 'port', 'ports', 'os', 'env'],
  },
];

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const isCjkTerm = (t: string) => CJK.test(t);

/** Whole-word (Latin) or substring (CJK) containment, over lower-cased text. */
function containsTerm(hay: string, term: string): boolean {
  if (isCjkTerm(term)) return hay.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Plural-tolerant: "mistake" also matches "mistakes".
  return new RegExp(`(^|[^a-z0-9_])${escaped}s?($|[^a-z0-9_])`).test(hay);
}

export interface ConceptHit {
  concept: Concept;
  /** The word in the text that named it — quoted in traces. */
  term: string;
}

/** Concepts a text names, each with the first word that named it. */
export function detectConcepts(text: string): ConceptHit[] {
  const hay = String(text ?? '').toLowerCase();
  if (!hay.trim()) return [];
  const out: ConceptHit[] = [];
  for (const concept of CONCEPTS) {
    // Longest term first, so the trace quotes "犯过的错" rather than "错".
    const term = [...concept.terms].sort((a, b) => b.length - a.length).find((t) => containsTerm(hay, t));
    if (term) out.push({ concept, term });
  }
  return out;
}

/**
 * Bigrams that carry grammar, not subject matter.
 *
 * A bigram is dropped from the query when it is one of these, or when it contains one of the
 * function characters below — "后如" (from "出错后如何") is not a word, and it only ever matched by
 * accident. Query side only.
 */
const CJK_STOP_BIGRAMS = new Set([
  '如何', '怎么', '怎样', '为什', '什么', '为何', '哪些', '哪个', '是否', '可以', '能否', '之前', '以前', '之后',
  '以后', '一直', '一下', '这个', '那个', '这些', '那些', '我们', '你们', '他们', '自己', '时候', '现在', '已经',
  '还是', '或者', '因为', '所以', '但是', '然后', '如果', '就是', '一个', '有没', '没有', '到底', '怎么', '回事',
  '么回', '别再', '再犯', '得出', '出的',
]);
const CJK_FUNCTION_CHARS = /[的了吗呢吧啊么着和与及或而被把让给在是有也都就又再很更最如何]/;

const LATIN_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'is', 'are',
  'was', 'were', 'be', 'been', 'do', 'does', 'did', 'how', 'what', 'why', 'which', 'who', 'when', 'where', 'my',
  'our', 'your', 'this', 'that', 'these', 'those', 'it', 'its', 'can', 'could', 'should', 'would', 'get', 'got',
  'last', 'time', 'own', 'full', 'much', 'many', 'any', 'some', 'there', 'here', 'me', 'we', 'you', 'they', 'i',
]);

/**
 * ID-like tokens: letters and digits joined by `-` or `_` that NAME one thing (`MEMO-55`,
 * `R6-PROBE-ALPHA`, `plan_4dda269d`), as opposed to hyphenated words (`self-reflection`).
 * Recognised when the run mixes letters and digits, or is written in capitals with a hyphen
 * (`MARKER-XYZ`).
 *
 * Such a token is matched WHOLE. Its pieces ("memo", "r6", "probe") are not what was asked for:
 * as separate terms they let a note that merely says "memo" tie with the exact hit, and when the ID
 * itself matched nothing (a retired probe node) they filled the primary list with every note that
 * happened to mention "R6". Query side only — the index keeps the whole token anyway.
 */
const ID_RUN = /[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+/g;

/** True for one run (original casing) that is an ID, not words (see `ID_RUN`). */
export function isIdLike(run: string): boolean {
  if (!/^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+$/.test(run)) return false;
  const letters = /[A-Za-z]/.test(run);
  if (letters && /[0-9]/.test(run)) return true;
  return letters && run.includes('-') && run === run.toUpperCase() && /[A-Z]{2}/.test(run);
}

/** The ID-like runs of a text, lower-cased as the index stores tokens. */
export function idTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of String(text ?? '').match(ID_RUN) ?? []) if (isIdLike(run)) out.add(run.toLowerCase());
  return out;
}

/** A fallback unit that is an ID (contains '-', or '_' with letters and digits): matched exactly. */
function isIdUnit(unit: string): boolean {
  return unit.includes('-') || (unit.includes('_') && /[0-9]/.test(unit) && /[a-z]/.test(unit));
}

/** True when a query token carries no subject matter. */
export function isQueryStopToken(token: string): boolean {
  if (isCjkTerm(token)) {
    if (token.length !== 2) return false; // whole runs are kept; they only ever match verbatim
    return CJK_STOP_BIGRAMS.has(token) || CJK_FUNCTION_CHARS.test(token);
  }
  return LATIN_STOP.has(token);
}

/** A weighted term for the lexical channel, with the reason it is there. */
export interface WeightedTerm {
  token: string;
  weight: number;
  /** '' for a word of the query itself; otherwise "<query word>→<concept>". */
  via: string;
}

/** How much an expansion word counts next to a word the user actually typed. */
export const EXPANSION_WEIGHT = 0.45;

/**
 * The query as weighted lexical terms: its own words (minus function words), light English
 * singulars, and the words of every concept it names.
 *
 * `tokenize` is the index's own tokenizer, passed in so query and index cannot disagree about
 * what a token is.
 */
export function queryTerms(query: string, tokenize: (text: string) => string[]): {
  terms: WeightedTerm[];
  concepts: ConceptHit[];
  /** The query's own content tokens (after stop-word removal) — what coverage is measured on. */
  own: string[];
} {
  const raw = tokenize(query);
  const ids = idTokens(query);
  let own = raw.filter((t) => !isQueryStopToken(t));
  // A query made only of function words is still a query: keep it rather than search for nothing.
  if (!own.length) own = raw;
  const terms = new Map<string, WeightedTerm>();
  const put = (token: string, weight: number, via: string) => {
    const prev = terms.get(token);
    if (!prev || prev.weight < weight) terms.set(token, { token, weight, via });
  };
  for (const t of own) {
    put(t, 1, '');
    if (isCjkTerm(t)) continue;
    if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) put(t.slice(0, -1), 0.9, '');
    // "self-reflection": the index also holds the parts when the text spells them apart. Hyphens
    // only — an underscore joins an identifier ("lsp_diagnostics", "no_such_symbol"), and its parts
    // ("no", "such") would match unrelated text that happens to say "no such file".
    // An ID (`MEMO-55`) is one name; only hyphenated WORDS contribute their parts.
    if (t.includes('-') && !ids.has(t.replace(/\.+$/, ''))) for (const part of t.split(/-+/)) if (part.length > 1 && !isQueryStopToken(part)) put(part, 0.9, '');
  }
  const concepts = detectConcepts(query);
  for (const hit of concepts) {
    for (const term of hit.concept.terms) {
      const pieces = tokenize(term).filter((t) => !isQueryStopToken(t));
      // A long term's pieces share its weight, so a four-character idiom does not outvote a word.
      const bigrams = pieces.filter((p) => !(isCjkTerm(p) && p.length > 2 && pieces.length > 1));
      const share = bigrams.length ? EXPANSION_WEIGHT / Math.sqrt(bigrams.length) : 0;
      for (const p of bigrams) put(p, share, `${hit.term}→${hit.concept.id}`);
    }
  }
  return { terms: [...terms.values()], concepts, own };
}

/**
 * The concepts a group is ABOUT, with how strongly.
 *
 *   - its own name names the concept           → 1.0   (`errors` → mistake, `自省` → reflection)
 *   - an ancestor's name names it              → 0.8   (`errors/shell` is still about mistakes)
 *   - its members' titles name it              → up to 0.6, by the share of titles that do
 *
 * Derived, not stored: a pure function of names and titles, so it can never drift from them.
 */
export function groupConcepts(input: {
  name: string;
  ancestorNames: string[];
  memberTitles: string[];
}): Map<string, { weight: number; term: string; source: 'name' | 'ancestor' | 'members' }> {
  const out = new Map<string, { weight: number; term: string; source: 'name' | 'ancestor' | 'members' }>();
  const put = (id: string, weight: number, term: string, source: 'name' | 'ancestor' | 'members') => {
    const prev = out.get(id);
    if (!prev || prev.weight < weight) out.set(id, { weight, term, source });
  };
  const words = (name: string) => name.toLowerCase().replace(/[/_.\-]+/g, ' ');
  for (const h of detectConcepts(words(input.name))) put(h.concept.id, 1, h.term, 'name');
  for (const a of input.ancestorNames) for (const h of detectConcepts(words(a))) put(h.concept.id, 0.8, h.term, 'ancestor');
  if (input.memberTitles.length) {
    const counts = new Map<string, { n: number; term: string }>();
    for (const title of input.memberTitles) {
      for (const h of detectConcepts(words(title))) {
        const c = counts.get(h.concept.id) ?? { n: 0, term: h.term };
        c.n++;
        counts.set(h.concept.id, c);
      }
    }
    for (const [id, c] of counts) put(id, 0.6 * (c.n / input.memberTitles.length), c.term, 'members');
  }
  return out;
}

/**
 * Matching units for the fallback pass: CJK bigrams, and whole Latin words (3+ characters).
 *
 * Coarser than the index tokens on the CJK side — any two adjacent characters, so a paraphrase that
 * shares fragments of a phrase still overlaps. On the Latin side it is NOT character n-grams: those
 * were tried and matched everything ("recipe hydration" overlapped notes about `plan_update` through
 * "rea", "tio", "ion"). Latin words match by shared prefix instead (see `unitMatches`), which is what
 * the fallback is for there: "migrat" finding "migration", a truncated or inflected word.
 */
export function fallbackUnits(text: string, role: 'query' | 'doc' = 'doc'): Set<string> {
  const out = new Set<string>();
  const lower = String(text ?? '').toLowerCase();
  /*
   * IDs are units of their own, matched exactly (`unitMatches`). On the query side their pieces are
   * NOT units: "R6-PROBE-ALPHA" must not turn into leads about anything saying "probe" or "alpha".
   */
  const ids = idTokens(text);
  for (const id of ids) out.add(id);
  let words = lower;
  if (role === 'query') for (const id of ids) words = words.split(id).join(' ');
  for (const run of lower.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const g = run.slice(i, i + 2);
      if (!isQueryStopToken(g)) out.add(g);
    }
  }
  for (const word of words.match(/[a-z0-9_]{3,}/g) ?? []) {
    if (!LATIN_STOP.has(word)) out.add(word);
  }
  return out;
}

/**
 * Whether a query unit is present in a node's units. CJK bigrams match exactly; a Latin word matches
 * a word sharing a prefix of at least 4 characters and at least three quarters of the shorter word.
 */
export function unitMatches(unit: string, docUnits: Set<string>): boolean {
  if (docUnits.has(unit)) return true;
  if (isCjkTerm(unit) || unit.length < 4 || isIdUnit(unit)) return false;
  for (const w of docUnits) {
    if (isCjkTerm(w) || w.length < 4 || w[0] !== unit[0]) continue;
    const need = Math.max(4, Math.ceil(0.75 * Math.min(unit.length, w.length)));
    let k = 0;
    while (k < unit.length && k < w.length && unit[k] === w[k]) k++;
    if (k >= need) return true;
  }
  return false;
}
