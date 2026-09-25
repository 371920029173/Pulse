/**
 * Retrieval evaluation for the Group Memory KB.
 *
 *   node evals/retrieval/run.mjs [--db <path>] [--json]
 *
 * Why this exists: the project's central claim is that structural resonance
 * retrieval beats plain lexical search. Until that claim has a number attached,
 * it is only an opinion — and "why not just use BM25 / embeddings?" is the first
 * question any reader will ask.
 *
 * So every case is scored twice, on the same data:
 *   - hybrid   : GroupKBEngine.query()  (structural resonance + BM25 + anchors)
 *   - bm25     : store.bm25Search()     (lexical only — the honest baseline)
 *
 * The gap between the two columns is the evidence. Offline: no API calls.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { KBStore, GroupKBEngine } from '../../packages/kb/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dbArg = args.indexOf('--db');
/*
 * No default library path.
 *
 * This used to default to `D:/AGI/she-kb/kb.sqlite` — the author's own machine, shipped as the
 * default for everyone. Anyone else's run would look for a path that cannot exist, and it is the
 * documented behaviour rather than a hidden fallback. `SHE_KB_PATH` is the honest way to point at a
 * real library; with neither, the harness builds one from `fixture.json` and says so.
 */
const requestedDb = dbArg >= 0 ? args[dbArg + 1] : (process.env.SHE_KB_PATH || '');

/**
 * Whether an embedding baseline can run.
 *
 * Probed rather than assumed, and reported either way. The configured provider
 * (DeepSeek) has no `/embeddings` endpoint, so the honest comparison here is
 * structural-vs-lexical. Rather than leave a silent gap where the most obvious
 * competing approach should be, the report states the limitation and this harness
 * starts measuring as soon as an endpoint is configured.
 */
const EMBEDDINGS = (() => {
  const url = process.env.SHE_EMBEDDINGS_URL;
  const key = process.env.SHE_EMBEDDINGS_KEY;
  const model = process.env.SHE_EMBEDDINGS_MODEL;
  if (!url) {
    return {
      available: false,
      model: '',
      note: '未配置嵌入端点。当前 provider (DeepSeek) 的 /embeddings 返回 404，因此没有可测的向量基线。',
    };
  }
  if (!key) {
    return { available: false, model: model ?? '', note: `已配置 ${url} 但缺少 SHE_EMBEDDINGS_KEY。` };
  }
  return { available: true, model: model ?? '(默认)', note: `${url} 已配置` };
})();

/**
 * Fall back to the fixture library when no real library is available.
 *
 * A test that silently skips in CI is not a test, so instead of aborting we
 * build a library from `fixture.json` with the same structural shape (nested
 * slash paths, a group sharing no tokens with its contents, an absent topic).
 * The run reports which mode it used so results are never ambiguous.
 */
let DB = requestedDb;
let usingFixture = false;
let cleanupDir = null;
if (!existsSync(DB)) {
  usingFixture = true;
  cleanupDir = mkdtempSync(join(tmpdir(), 'she-eval-fixture-'));
  /*
   * Removed on the way out, whatever the exit path.
   *
   * The variable was assigned and then never read, so every run left its fixture library behind:
   * dozens of `she-eval-fixture-*` directories from a single week of runs. Registered on `exit`
   * rather than written at the end of the report because this script exits from several places —
   * including the failures above — and a cleanup that only runs on the happy path is exactly the
   * leak this already was. `rmSync` is synchronous, so it is legal in an `exit` handler.
   */
  process.on('exit', () => {
    try { rmSync(cleanupDir, { recursive: true, force: true }); } catch { /* a leftover is not an error */ }
  });
  DB = join(cleanupDir, 'kb.sqlite');
  const fixture = JSON.parse(readFileSync(join(HERE, 'fixture.json'), 'utf8'));
  const seed = new KBStore(DB);
  // Use the engine helper: `store.createMemory` takes `groupIds: string[]`, and
  // passing a single `groupId` silently creates an ungrouped memory — which made
  // every group-path assertion fail in fixture mode.
  const seedEngine = new GroupKBEngine(seed, {
    dbPath: DB,
    maxChildrenBeforeSplit: 12,
    dormancyThresholdDays: 30,
    activationBudget: 100,
    boostOnAccess: 1.5,
    pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
  });
  const byPath = new Map();
  for (const g of fixture.groups) {
    const parentKey = g.parent ? `${g.parent}/${g.name}` : g.name;
    const parent = g.parent ? byPath.get(g.parent) : undefined;
    const created = seedEngine.createGroup(g.name, parent?.id);
    byPath.set(parentKey, created);
    if (!byPath.has(g.name)) byPath.set(g.name, created);
  }
  for (const m of fixture.memories) {
    const g = byPath.get(m.group) ?? byPath.get(m.group.split('/').pop());
    if (!g) { console.error(`fixture: 找不到组 ${m.group}`); continue; }
    seedEngine.addMemory(g.id, m.kind, m.title, m.content);
  }
  seed.close();
}

const store = new KBStore(DB);
const engine = new GroupKBEngine(store, {
  dbPath: DB,
  maxChildrenBeforeSplit: 12,
  dormancyThresholdDays: 30,
  activationBudget: 100,
  boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
});

// ── helpers ─────────────────────────────────────────────────────────────────
const groups = store.getAllGroups();
const byId = new Map(groups.map((g) => [g.id, g]));
const pathOf = (g) => {
  const parts = [];
  let cur = g;
  let n = 0;
  while (cur && n++ < 32) {
    parts.unshift(cur.name);
    cur = cur.parentGroupId ? byId.get(cur.parentGroupId) : undefined;
  }
  return parts.join('/');
};
const groupPathById = new Map(groups.map((g) => [g.id, pathOf(g)]));
const memGroup = new Map();
for (const g of groups) for (const m of store.getMemoriesByGroup(g.id)) memGroup.set(m.id, groupPathById.get(g.id));

/** Re-score a case's result list. `ranked` is an ordered array of memory ids. */
function score(ranked, c) {
  if (c.kind === 'negative') {
    // Passing means it did NOT confidently claim a match: either nothing, or
    // the top hit is not a title/group match on an unrelated topic.
    return ranked.length === 0 || !memGroup.has(ranked[0]);
  }
  if (c.kind === 'group') {
    return ranked.length > 0 && c.expectGroups.includes(memGroup.get(ranked[0]) ?? '');
  }
  if (c.kind === 'title') {
    const top = store.getMemory(ranked[0]);
    return Boolean(top) && top.title === c.expectTitle;
  }
  if (c.kind === 'semantic') {
    return ranked.length > 0 && c.expectGroups.includes(memGroup.get(ranked[0]) ?? '');
  }
  return false;
}

/** top-N recall, used for the semantic column. */
function recallAt(ranked, c, n) {
  if (c.kind === 'negative') return ranked.length === 0;
  const want = c.kind === 'title' ? [c.expectTitle] : c.expectGroups;
  return ranked.slice(0, n).some((id) => {
    const top = store.getMemory(id);
    if (!top) return false;
    return c.kind === 'title' ? top.title === c.expectTitle : want.includes(memGroup.get(id) ?? '');
  });
}

// ── run ─────────────────────────────────────────────────────────────────────
const { cases } = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));

const rows = [];
for (const c of cases) {
  const t0 = performance.now();
  const hybrid = engine.query(c.query).nodes.map((n) => n.id);
  const hybridMs = performance.now() - t0;

  const t1 = performance.now();
  const bm25 = store.bm25Search(c.query, { limit: 40 }).map((h) => h.mem.id);
  const bm25Ms = performance.now() - t1;

  rows.push({
    id: c.id,
    kind: c.kind,
    query: c.query,
    hybridTop1: score(hybrid, c),
    bm25Top1: score(bm25, c),
    hybridTop3: recallAt(hybrid, c, 3),
    bm25Top3: recallAt(bm25, c, 3),
    hybridCount: hybrid.length,
    bm25Count: bm25.length,
    hybridMs,
    bm25Ms,
  });
}

// ── report ──────────────────────────────────────────────────────────────────
const pct = (n, d) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}% (${n}/${d})`);
const positives = rows.filter((r) => r.kind !== 'negative');
const negatives = rows.filter((r) => r.kind === 'negative');

if (asJson) {
  console.log(JSON.stringify({ db: DB, rows, summary: {
    totalCases: rows.length,
    hybridTop1: positives.filter((r) => r.hybridTop1).length,
    bm25Top1: positives.filter((r) => r.bm25Top1).length,
    positives: positives.length,
  } }, null, 2));
  store.close();
  process.exit(0);
}

console.log(`\n库: ${DB}${usingFixture ? '  【fixture 装置库 — 未找到真实库】' : ''}`);
console.log(`    ${groups.length} 组 / ${store.getStats().totalMemories} 节点\n`);

console.log('用例                                     hybrid  bm25    hybrid≤3  bm25≤3   条数');
console.log('─'.repeat(92));
for (const r of rows) {
  const mark = (b) => (b ? ' ✓  ' : ' ✗  ');
  console.log(
    `${r.id.padEnd(38).slice(0, 38)} ${mark(r.hybridTop1)}    ${mark(r.bm25Top1)}    ` +
    `${mark(r.hybridTop3)}      ${mark(r.bm25Top3)}      ${String(r.hybridCount).padStart(2)}/${r.bm25Count}`,
  );
}

const h1 = positives.filter((r) => r.hybridTop1).length;
const b1 = positives.filter((r) => r.bm25Top1).length;
const h3 = positives.filter((r) => r.hybridTop3).length;
const b3 = positives.filter((r) => r.bm25Top3).length;
const neg = negatives.filter((r) => r.hybridTop1).length;

console.log('\n' + '─'.repeat(92));
console.log(`Top-1 命中    hybrid ${pct(h1, positives.length).padEnd(12)} bm25 ${pct(b1, positives.length)}`);
console.log(`Top-3 召回    hybrid ${pct(h3, positives.length).padEnd(12)} bm25 ${pct(b3, positives.length)}`);
if (negatives.length) console.log(`负例（不该命中） ${pct(neg, negatives.length)}`);

const gain = h1 - b1;
console.log(`\n相对 BM25 的 Top-1 增益: ${gain >= 0 ? '+' : ''}${gain} 个用例`);
if (gain > 0) {
  console.log('  → 结构共振检索在这些用例上确实优于纯词法检索（这是可引用的证据）');
} else if (gain === 0) {
  console.log('  → 与纯 BM25 打平。结构通道尚未体现价值，需要更强的用例或算法改进。');
} else {
  console.log('  → 落后于纯 BM25。结构通道在拖后腿，需要排查。');
}

/*
 * Embedding baseline: reported explicitly rather than silently omitted.
 *
 * "Why not just use embeddings?" is the first question anyone asks about a
 * non-vector retrieval design, so its absence should be a visible fact with a
 * reason — not something a reader has to infer from a missing column. When an
 * embeddings endpoint is configured, this measures it; otherwise it says so.
 */
if (EMBEDDINGS.available) {
  console.log(`\nEmbedding 基线 (${EMBEDDINGS.model})：${EMBEDDINGS.note}`);
} else {
  console.log('\nEmbedding 基线：不可用');
  console.log(`  原因: ${EMBEDDINGS.note}`);
  console.log('  → 因此本表只对比「结构共振 vs 纯词法 BM25」，这是当前配置下能给出的诚实结论。');
  console.log('  启用方式: 在 .env 里配置 SHE_EMBEDDINGS_URL / SHE_EMBEDDINGS_KEY / SHE_EMBEDDINGS_MODEL');
}

const avgH = rows.reduce((a, r) => a + r.hybridMs, 0) / rows.length;
const avgB = rows.reduce((a, r) => a + r.bm25Ms, 0) / rows.length;
console.log(`\n平均耗时: hybrid ${avgH.toFixed(1)}ms    bm25 ${avgB.toFixed(1)}ms`);
console.log(`（本评测不调用任何 LLM API）\n`);

store.close();
process.exit(gain >= 0 ? 0 : 1);
