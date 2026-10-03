/**
 * Recall evaluation for kb_query — meaning-only paraphrases next to lexical controls.
 *
 *   node evals/recall/run.mjs                 # fixture.json (a synthetic library, hand-written)
 *   node evals/recall/run.mjs --db <kb.sqlite> # a real library; it is COPIED first, never written
 *   node evals/recall/run.mjs --db <kb.sqlite> --alias project/demo-app=project/<yours>
 *                                             # map the fixture's group names onto that library's
 *   node evals/recall/run.mjs --json
 *   node evals/recall/run.mjs --check          # exit 1 when a floor in cases.json is missed
 *
 * `evals/retrieval` asks "does structure beat BM25 on addressable queries". This one asks the
 * question a live agent actually hit: a query that states the MEANING ("how do I avoid repeating
 * past mistakes") and shares no words with the notes that answer it. Offline, no LLM calls.
 *
 * Each query runs against a fresh copy of the library, because `query()` reinforces what it
 * returns (access counts): without the copy, the order of the cases would change the scores.
 *
 * Metrics, over PRIMARY results (`result.nodes`): hit@1, hit@5, MRR@10. Fallback hits
 * (`result.fallback`) are reported in their own column and never count as primary — a negative
 * case passes only when the primary list is empty.
 */
import { readFileSync, copyFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { KBStore, GroupKBEngine, collapseGroupNameChain } from '../../packages/kb/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const check = args.includes('--check');
const dbArg = args.indexOf('--db');
const requestedDb = dbArg >= 0 ? args[dbArg + 1] : '';
/** `--alias from=to` (repeatable): rewrite expected group-path prefixes for a real library. */
const aliases = args.flatMap((a, i) => (a === '--alias' && args[i + 1]?.includes('=') ? [args[i + 1].split('=')] : []));
const aliasPath = (p) => {
  for (const [from, to] of aliases) if (p === from || p.startsWith(from + '/')) return to + p.slice(from.length);
  return p;
};

const CONFIG = (dbPath) => ({
  dbPath,
  maxChildrenBeforeSplit: 12,
  dormancyThresholdDays: 30,
  activationBudget: 100,
  boostOnAccess: 1.5,
  pulseSeed: { initialEnergy: 1.0, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
});

const work = mkdtempSync(join(tmpdir(), 'she-recall-eval-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* leftover is not an error */ } });

const base = join(work, 'base.sqlite');
let source = 'fixture';
if (requestedDb) {
  if (!existsSync(requestedDb)) { console.error(`找不到库: ${requestedDb}`); process.exit(2); }
  // Copy, never open the original: query() writes access counts.
  copyFileSync(requestedDb, base);
  for (const ext of ['-wal', '-shm']) if (existsSync(requestedDb + ext)) copyFileSync(requestedDb + ext, base + ext);
  source = requestedDb;
  const s = new KBStore(base); s.close(); // folds a copied WAL into the main file
} else {
  const fx = JSON.parse(readFileSync(join(HERE, 'fixture.json'), 'utf8'));
  const store = new KBStore(base);
  const engine = new GroupKBEngine(store, CONFIG(base));
  const gid = new Map();
  for (const g of fx.groups) gid.set(g.key, engine.createGroup(g.name, g.parent ? gid.get(g.parent) : undefined).id);
  const mid = new Map();
  for (const m of fx.memories) {
    const id = engine.addMemory(gid.get(m.group), m.kind, m.title, m.content).id;
    mid.set(m.key, id);
    // A retired node stays in the library but out of every default read (an ID query must not find it).
    if (m.retired) engine.retireMemory(id, { reason: 'synthetic retired node' });
  }
  for (const e of fx.edges) {
    try { engine.addTypedEdge(mid.get(e.source), mid.get(e.target), e.kind); } catch { /* an edge the engine refuses is not the point here */ }
  }
  store.close();
}

const { cases, floors = {} } = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));

// Group paths, read once from the base copy.
const meta = new KBStore(base);
const groups = meta.getAllGroups();
const byId = new Map(groups.map((g) => [g.id, g]));
const pathOf = (g) => {
  const parts = [];
  let cur = g;
  for (let n = 0; cur && n < 32; n++) { parts.unshift(cur.name); cur = cur.parentGroupId ? byId.get(cur.parentGroupId) : undefined; }
  return collapseGroupNameChain(parts).join('/');
};
const nodeInfo = new Map();
for (const g of groups) for (const m of meta.getMemoriesByGroup(g.id)) nodeInfo.set(m.id, { path: pathOf(g), title: m.title, content: m.content });
const nodeCount = nodeInfo.size;
meta.close();

/**
 * A node that quotes a MEANING query verbatim (a report about this very evaluation, written into a
 * real library afterwards) would turn it into a lexical case. It is deleted from that query's copy —
 * not just filtered from the results, because it would still shape the ranking (as the top hit it
 * decides how literal the query looks). Only meaning queries: a lexical control should match literally.
 */
const leaks = new Set([...nodeInfo]
  .filter(([, n]) => cases.some((c) => (c.class === 'meaning' || c.class === 'heldout') && n.content.includes(c.query)))
  .map(([id]) => id));

const isHit = (id, c) => {
  const n = nodeInfo.get(id);
  if (!n) return false;
  const g = (c.expect.groups ?? []).map(aliasPath);
  const t = c.expect.titles ?? [];
  return g.some((p) => n.path === p || n.path.startsWith(p + '/')) || t.some((s) => n.title.includes(s));
};
const rankOf = (ids, c, k = 10) => {
  const i = ids.slice(0, k).findIndex((id) => isHit(id, c));
  return i < 0 ? 0 : i + 1;
};

const rows = [];
let n = 0;
for (const c of cases) {
  const db = join(work, `q${n++}.sqlite`);
  copyFileSync(base, db);
  const store = new KBStore(db);
  const engine = new GroupKBEngine(store, CONFIG(db));
  if (c.class === 'meaning' || c.class === 'heldout') for (const id of leaks) store.deleteMemory(id);
  const t0 = performance.now();
  // A query that spells a group path (lex-group-env) is aliased the same way.
  const res = engine.query(aliases.reduce((s, [from, to]) => s.split(from).join(to), c.query));
  const ms = performance.now() - t0;
  const primary = res.nodes.map((x) => x.id).filter((id) => !leaks.has(id));
  const fallback = (res.fallback?.nodes ?? []).map((x) => x.id).filter((id) => !leaks.has(id) && !primary.includes(id));
  const topScore = res.traces[0]?.finalScore ?? 0;
  store.close();
  rows.push({
    id: c.id, class: c.class, lang: c.lang, query: c.query,
    primaryCount: primary.length, fallbackCount: fallback.length, topScore, ms,
    rank: c.class === 'negative' ? null : rankOf(primary, c),
    rankWithFallback: c.class === 'negative' ? null : rankOf([...primary, ...fallback], c),
    negativeOk: c.class === 'negative' ? primary.length === 0 : null,
    top: primary.slice(0, 3).map((id) => `${nodeInfo.get(id)?.path} :: ${nodeInfo.get(id)?.title}`.slice(0, 90)),
    fallbackTop: fallback.slice(0, 2).map((id) => `${nodeInfo.get(id)?.path} :: ${nodeInfo.get(id)?.title}`.slice(0, 90)),
  });
}

function summarize(list, key = 'rank') {
  const pos = list.filter((r) => r.class !== 'negative');
  const d = pos.length || 1;
  return {
    cases: pos.length,
    hit1: pos.filter((r) => r[key] === 1).length / d,
    hit5: pos.filter((r) => r[key] >= 1 && r[key] <= 5).length / d,
    mrr: pos.reduce((a, r) => a + (r[key] ? 1 / r[key] : 0), 0) / d,
  };
}
const summary = {
  all: summarize(rows),
  meaning: summarize(rows.filter((r) => r.class === 'meaning')),
  lexical: summarize(rows.filter((r) => r.class === 'lexical')),
  heldout: summarize(rows.filter((r) => r.class === 'heldout')),
  allWithFallback: summarize(rows, 'rankWithFallback'),
  meaningWithFallback: summarize(rows.filter((r) => r.class === 'meaning'), 'rankWithFallback'),
  negatives: { cases: rows.filter((r) => r.class === 'negative').length, ok: rows.filter((r) => r.negativeOk).length },
};

const misses = [];
for (const [key, floor] of Object.entries(floors)) {
  const [group, metric] = key.split('.');
  const got = summary[group]?.[metric];
  if (typeof got === 'number' && got + 1e-9 < floor) misses.push(`${key} = ${got.toFixed(3)} < ${floor}`);
}
if (summary.negatives.ok < summary.negatives.cases) misses.push(`negatives ${summary.negatives.ok}/${summary.negatives.cases}`);

if (asJson) {
  console.log(JSON.stringify({ source, nodes: nodeCount, leaksExcluded: leaks.size, rows, summary, misses }, null, 2));
} else {
  const f = (x) => x.toFixed(3);
  console.log(`\n库: ${source}   ${groups.length} 组 / ${nodeCount} 节点${leaks.size ? `   （排除 ${leaks.size} 个逐字引用评测查询的节点）` : ''}\n`);
  console.log('用例                              类别      主排名  含兜底  主/兜底  top分   top-1');
  console.log('─'.repeat(110));
  for (const r of rows) {
    const rank = r.class === 'negative' ? (r.negativeOk ? '  ok ' : ' FAIL') : (r.rank ? `  #${r.rank}  ` : '  —   ');
    const rf = r.class === 'negative' ? '     ' : (r.rankWithFallback ? `  #${r.rankWithFallback}` : '  —  ');
    console.log(`${r.id.padEnd(33).slice(0, 33)} ${r.class.padEnd(8)} ${rank.padEnd(7)} ${rf.padEnd(6)} ${`${r.primaryCount}/${r.fallbackCount}`.padStart(6)}  ${r.topScore.toFixed(2).padStart(5)}  ${r.top[0] ?? (r.fallbackTop[0] ? `〔兜底〕${r.fallbackTop[0]}` : '')}`);
  }
  console.log('─'.repeat(110));
  for (const [k, s] of Object.entries(summary)) {
    if (k === 'negatives') console.log(`negatives           ${s.ok}/${s.cases} 无主结果`);
    else console.log(`${k.padEnd(20)} hit@1 ${f(s.hit1)}  hit@5 ${f(s.hit5)}  MRR ${f(s.mrr)}  (n=${s.cases})`);
  }
  if (check) console.log(misses.length ? `\nFAIL  ${misses.join('；')}` : '\nPASS  全部达到 cases.json 的下限');
  console.log('（本评测不调用任何 LLM API）\n');
}
process.exit(check && misses.length ? 1 : 0);
