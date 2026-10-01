/**
 * 大规模检索质量对照实验（评测报告 5a + 5b）。
 *
 * 报告的原话是「机制全对……但只用 8–12 个自写节点验过，没验 ≥1k 节点的精度与召回」。这条检查补的
 * 就是那个规模差：一个 8 节点的库里，答案排第一是理所当然的；同一套打分在 1250 个节点里可能把答案
 * 挤到第 30 位，而**分数看起来一样漂亮**。所以判据不是「有没有返回」，是「答案在不在前十、排第几」。
 *
 * ─── 口径（重要） ─────────────────────────────────────────────────────────────
 *
 * 「向量」这个说法在本仓库不成立：这套检索是 PulseSeed 结构共振 + BM25 词法，**没有 embedding 通道**
 * （`engine.ts` 里写得很明确："structural resonance, NOT RAG"）。所以对照的是三条：
 *
 *   · 纯关键词   —— 只用 BM25 排序（`channels: ['lexical']`）
 *   · 纯结构     —— 只用共振激活排序（`channels: ['structural']`）
 *   · 融合       —— 生产默认（两条加权，0.55 / 0.45）
 *
 * 两个通道**共享入口**（BM25 命中 + 显式锚点），分开的只有分数。这不是偷懒：结构共振要有种子才能
 * 传播，把入口也关掉的话"纯结构"在非锚点查询上永远返回空 —— 那测的是一个坏掉的开关，不是一条通道。
 *
 * ─── 语料 ────────────────────────────────────────────────────────────────────
 *
 * 250 个主题，每个主题：1 个中心节点 + 3 个条目（同一个组），另加 1 个"旁证"节点放在**另一个组**，
 * 靠一条显式 weak 边连到中心。共 1250 个节点 —— 规模这一项是硬要求，不能缩。
 *
 *   node scripts/kb-retrieval-check.mjs [--verbose]
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { KBStore, GroupKBEngine } from '../packages/kb/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VERBOSE = process.argv.includes('--verbose');

const TOPICS = 250;
const SPOKES = 3;

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 400)}`);
  }
};

// ─── 语料 ────────────────────────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'she-kb-retrieval-'));
const store = new KBStore(join(dir, 'kb.sqlite'));
const engine = new GroupKBEngine(store, {
  ...configStub(join(dir, 'kb.sqlite')),
});

function configStub(dbPath) {
  return {
    dbPath,
    maxChildrenBeforeSplit: 12,
    dormancyThresholdDays: 30,
    activationBudget: 120,
    boostOnAccess: 1.5,
    pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
  };
}

/**
 * 中心节点是唯一含 `code` 这个生僻词的节点 —— 于是"纯关键词"查询只能从这里进入，
 * 而"旁证"节点与查询**零共同词**，只有结构能到达它。这就是 B 族要测的那件事。
 */
function buildCorpus() {
  const ids = { hub: [], spoke: [], aside: [] };
  for (let t = 0; t < TOPICS; t++) {
    const code = `kx${t}`;
    const gid = engine.createGroup(`grp${t}`).id;
    const hub = engine.addMemory(gid, 'fact', `${code} 索引`, `主题入口。标记 ${code}。`);
    ids.hub.push(hub.id);
    for (let k = 0; k < SPOKES; k++) {
      const sp = engine.addMemory(
        gid, 'fact',
        `条目 ${t}-${k}`,
        `编号 ${t} 的第 ${k} 条记录，归入 ${code} 体系。`,
      );
      ids.spoke.push(sp.id);
      engine.addWeakEdge(hub.id, sp.id);
    }
    /*
     * 旁证放在**另一个组**，只靠一条边连回来。
     *
     * 如果它和中心同组，"同组成员互相激活"这一步就会把它抬起来 —— 那样测到的就不是关系召回，
     * 而是组大小。放进另一个组，能量只能沿这条边过去，判据才干净。
     *
     * 它的正文刻意不含 `code`，也不含 `编号 ${t}`：任何与查询共享的词都会让 BM25 也能找到它，
     * 于是 B 族就不再能区分两个通道。
     */
    const asideGroup = engine.createGroup(`aside${t}`).id;
    const aside = engine.addMemory(
      asideGroup, 'fact',
      `旁证 ${t}`,
      `与体系 ${t} 配套的一条旁证记录，说明该体系的边界条件。`,
    );
    ids.aside.push(aside.id);
    engine.addWeakEdge(hub.id, aside.id);
  }
  return ids;
}

const corpusStart = Date.now();
/*
 * 整段语料放进**一个**事务里建。
 *
 * `addMemory` 自己会开事务（读组文档、追加 id、写回），2500 次操作就是 2500 次提交 —— 实测这一项
 * 单独要两分多钟，而它跟检索质量毫无关系，只是 SQLite 的每条语句一次 fsync。嵌套事务在
 * better-sqlite3 里走 savepoint，语义不变。
 */
const ids = store.transaction(buildCorpus);
console.log(`  （语料构建 ${Date.now() - corpusStart}ms）`);


/** 三族查询 + 期望命中的节点。 */
function buildQueries() {
  const qs = [];
  // A 族｜精确定位：查询里带着只在目标上出现的稀有组合。规模越大越容易挤掉它，所以它测的是
  // BM25 在 1250 个节点里还能不能把答案排到第一。
  for (let t = 0; t < TOPICS; t += 10) {
    const k = t % SPOKES;
    qs.push({
      family: 'A 精确定位',
      text: `条目 ${t}-${k}`,
      expect: ids.spoke[t * SPOKES + k],
      note: `topic ${t} spoke ${k}`,
    });
  }
  // B 族｜关系召回：答案是那个与查询零共同词的旁证节点，只有结构通道能到达。
  for (let t = 1; t < TOPICS; t += 10) {
    qs.push({
      family: 'B 关系召回',
      text: `kx${t}`,
      expect: ids.aside[t],
      note: `topic ${t} aside（与查询无共同词）`,
    });
  }
  // C 族｜组名锚点：系统提示让模型"用组名搜"，这是那条建议能不能用的判据。
  for (let t = 2; t < TOPICS; t += 10) {
    qs.push({
      family: 'C 组名锚点',
      text: `grp${t}`,
      expect: ids.hub[t],
      // 这个组的全部成员。用来断言"问哪个组就只能拿到哪个组的东西"。
      members: new Set([ids.hub[t], ...ids.spoke.slice(t * SPOKES, t * SPOKES + SPOKES)]),
      note: `topic ${t} hub via group name`,
    });
  }
  return qs;
}

const queries = buildQueries();

// ─── 对照 ────────────────────────────────────────────────────────────────────

const CONFIGS = [
  { label: '纯关键词', channels: ['lexical'] },
  { label: '纯结构', channels: ['structural'] },
  { label: '融合', channels: ['lexical', 'structural'] },
];

const TOP_K = 10;

function runConfig(cfg) {
  const perFamily = new Map();
  let hits = 0;
  let rrSum = 0;
  let msSum = 0;

  for (const q of queries) {
    const r = engine.query(q.text, { channels: cfg.channels });
    msSum += r.queryTimeMs;
    const rank = r.nodes.findIndex((n) => n.id === q.expect);
    const hit = rank >= 0 && rank < TOP_K;
    if (hit) hits++;
    if (rank >= 0) rrSum += 1 / (rank + 1);

    const f = perFamily.get(q.family) ?? { n: 0, hits: 0, rr: 0, top4Clean: 0 };
    f.n++;
    if (hit) f.hits++;
    if (rank >= 0) f.rr += 1 / (rank + 1);
    /*
     * "前 4 名有没有混进别的组的东西"。
     *
     * 这是 C 族真正要盯的那件事。组名查询返回组内哪一条在前是次要的（组内次序见 engine 的
     * `anchorRank`），但**混进另一个组的内容**是硬错：实测里 `grp22` 的前四名全是主题 2 的内容，
     * 根源是 `q.includes(path)` 的子串匹配。recall 抓不到这种错（答案最后仍在第 8 位、仍在前十），
     * 所以必须单独数。
     */
    if (q.members) {
      const top = r.nodes.slice(0, 4);
      if (top.length > 0 && top.every((n) => q.members.has(n.id))) f.top4Clean++;
    }
    perFamily.set(q.family, f);

    if (VERBOSE) {
      console.log(`        [${cfg.label}] ${q.family} "${q.text}" -> ${rank < 0 ? '未命中' : `第 ${rank + 1} 位`} (${q.note})`);
    }
  }

  return {
    config: cfg,
    recall: hits / queries.length,
    mrr: rrSum / queries.length,
    avgMs: msSum / queries.length,
    perFamily,
  };
}

console.log('\n大规模检索质量对照（1250 节点 / 三通道 / 三族查询）\n');
console.log('=== 语料 ===');
console.log(`  主题 ${TOPICS} · 每条 ${SPOKES} 个条目 + 1 个旁证 · 节点总数 ${ids.hub.length + ids.spoke.length + ids.aside.length}`);
console.log(`  查询 ${queries.length} 条（${[...new Set(queries.map((q) => q.family))].join(' / ')}）`);

const results = CONFIGS.map(runConfig);

console.log('\n=== 结果 ===');
console.log(`  ${'通道'.padEnd(10)} ${'recall@10'.padEnd(12)} ${'MRR'.padEnd(8)} ${'平均耗时'}`);
for (const r of results) {
  console.log(`  ${r.config.label.padEnd(12)} ${r.recall.toFixed(3).padEnd(12)} ${r.mrr.toFixed(3).padEnd(8)} ${r.avgMs.toFixed(0)}ms`);
}

console.log('\n=== 分族（recall@10 / MRR） ===');
const families = [...new Set(queries.map((q) => q.family))];
console.log(`  ${'族'.padEnd(14)}${results.map((r) => r.config.label.padStart(16)).join('')}`);
for (const fam of families) {
  const row = results.map((r) => {
    const f = r.perFamily.get(fam);
    const rec = f ? f.hits / f.n : 0;
    const mrr = f ? f.rr / f.n : 0;
    return `${rec.toFixed(3)} / ${mrr.toFixed(3)}`.padStart(16);
  }).join('');
  console.log(`  ${fam.padEnd(14)}${row}`);
}

const byLabel = Object.fromEntries(results.map((r) => [r.config.label, r]));
const famRecall = (label, fam) => {
  const f = byLabel[label].perFamily.get(fam);
  return f ? f.hits / f.n : 0;
};
const famMrr = (label, fam) => {
  const f = byLabel[label].perFamily.get(fam);
  return f ? f.rr / f.n : 0;
};
// 只有带 members 的族（C 族）才计数，其余返回 1 表示"不适用，不拖后腿"。
const famTop4Clean = (label, fam) => {
  const f = byLabel[label].perFamily.get(fam);
  if (!f || !f.n) return 0;
  const withMembers = queries.filter((q) => q.family === fam && q.members).length;
  return withMembers ? f.top4Clean / withMembers : 1;
};

console.log('\n=== 判据 ===');
check('规模到位（≥1000 个节点）', ids.hub.length + ids.spoke.length + ids.aside.length >= 1000,
  `${ids.hub.length + ids.spoke.length + ids.aside.length} 个`);
check(`融合的 recall@${TOP_K} ≥ 0.90`, byLabel['融合'].recall >= 0.9,
  `${byLabel['融合'].recall.toFixed(3)}`);
/*
 * MRR 按族看，不看全局。
 *
 * 全局 MRR 被语料配比左右：B 族（关系召回）的答案天然排在中心与三个条目之后（能量沿边衰减，
 * 0.35 vs 1.0），所以哪怕每一族都做到最好，全局 MRR 也上不了 0.8 —— 拿它当门槛只会得到一个
 * 靠调语料配比才能过的数字，而不是一条关于检索质量的判据。
 */
check('精确定位族上，融合把答案排在第一（MRR = 1.0）',
  famMrr('融合', 'A 精确定位') === 1, `${famMrr('融合', 'A 精确定位').toFixed(3)}`);
check('关系召回族上，融合 MRR ≥ 0.15（答案确实被结构通道够到）',
  famMrr('融合', 'B 关系召回') >= 0.15, `${famMrr('融合', 'B 关系召回').toFixed(3)}`);

/*
 * 这一条是这次对照存在的理由：结构通道必须证明它**挣到了位置**。
 *
 * B 族的答案与查询零共同词，纯关键词在原理上就不可能找到它 —— 如果实测两者打平，说明结构通道
 * 没有在做事（或者这个语料根本没构造出那种查询），那么这个 0.55 的权重就是白拿的。
 */
const structEdge = famRecall('纯结构', 'B 关系召回') - famRecall('纯关键词', 'B 关系召回');
check('关系召回族上，纯结构严格优于纯关键词（结构通道挣到了它的权重）', structEdge > 0,
  `结构 ${famRecall('纯结构', 'B 关系召回').toFixed(3)} vs 关键词 ${famRecall('纯关键词', 'B 关系召回').toFixed(3)}`);

check('精确定位族上，纯关键词 recall ≥ 0.95（规模没有把 BM25 打散）',
  famRecall('纯关键词', 'A 精确定位') >= 0.95, `${famRecall('纯关键词', 'A 精确定位').toFixed(3)}`);

/*
 * 组名锚点这一族专门盯一个真实修掉的缺陷。
 *
 * 原来 `q.includes(path)` 做的是**子串**匹配，于是查询 `grp22` 里的 `grp22`.includes('grp2') 成立，
 * 前缀冲突的组 `grp2` 也被当成锚点。锚点带 3.5 倍加成，一次误判就把答案挤出前四 —— 实测该族
 * recall 只有 0.760，且前四名全是另一个主题的内容。真实命名里 `agent` / `agent-usability`、
 * `ops` / `ops-kb` 遍地都是，所以这条必须钉住。
 */
check('组名锚点族：前四名全部来自被问的那个组（没有串到前缀冲突的组）',
  famTop4Clean('纯结构', 'C 组名锚点') === 1 && famTop4Clean('融合', 'C 组名锚点') === 1,
  `纯结构 ${famTop4Clean('纯结构', 'C 组名锚点').toFixed(3)} / 融合 ${famTop4Clean('融合', 'C 组名锚点').toFixed(3)}`);
check('组名锚点族上，融合 recall ≥ 0.95（系统提示里那条建议真的能用）',
  famRecall('融合', 'C 组名锚点') >= 0.95, `${famRecall('融合', 'C 组名锚点').toFixed(3)}`);

/*
 * 融合不能比它最好的那条通道更差 —— 否则"融合"就是拿一条通道的收益去补贴另一条。
 * 容差 0.02 是给"两通道都在时分数排序可能互换"留的余量。
 */
const bestSingle = Math.max(byLabel['纯关键词'].mrr, byLabel['纯结构'].mrr);
check('融合不比最好的单通道差（容差 0.02）', byLabel['融合'].mrr >= bestSingle - 0.02,
  `融合 ${byLabel['融合'].mrr.toFixed(3)} vs 最好单通道 ${bestSingle.toFixed(3)}`);

// ─── 5b：可观测指标 ─────────────────────────────────────────────────────────

console.log('\n=== 检索质量可观测指标（5b）===');
{
  const r = engine.query('kx7');
  const d = r.diagnostics;
  check('每次查询都带回诊断读数', Boolean(d), 'diagnostics 缺失 —— 面板无从下手');
  if (d) {
    check('诊断里有通道、候选规模与分数分布',
      Array.isArray(d.channels) && typeof d.candidates.fused === 'number'
      && typeof d.scores.max === 'number' && typeof d.scores.median === 'number',
      JSON.stringify(d));
    check('分数分布不是空的（max > 0，且 aboveFloor 有值）',
      d.scores.max > 0 && d.scores.aboveFloor >= 1, JSON.stringify(d.scores));
    check('aboveFloor 不会超过返回上限（截断可见）',
      d.scores.aboveFloor <= d.limit, JSON.stringify(d.scores));
    console.log(`        通道 ${d.channels.join('+')} · 候选 词法${d.candidates.lexical}/结构${d.candidates.structural}/融合${d.candidates.fused}`);
    console.log(`        分数 max ${d.scores.max.toFixed(3)} · median ${d.scores.median.toFixed(3)} · floor ${d.scores.floor.toFixed(3)} · 返回 ${d.scores.aboveFloor}/${d.limit}`);
  }

  /*
   * 分数**分布**是这套指标里唯一能提前报警的那一项。
   *
   * 在 8 个节点的库里，第一名和第十名的分数都很高，看不出退化；一旦中位数抬到接近最大值，
   * "分数不低"就不再等于"找对了"。所以中位数必须真的低于最大值 —— 如果两者相等，说明这个库
   * （或打分）已经失去区分度，那本身就是该看见的事。
   */
  const broad = engine.query('编号 5');
  const bd = broad.diagnostics;
  check('宽查询下中位数低于最大值（打分还保有区分度）',
    Boolean(bd) && bd.scores.median < bd.scores.max,
    bd ? `median ${bd.scores.median.toFixed(3)} vs max ${bd.scores.max.toFixed(3)}` : '无诊断');
  console.log(`        宽查询"编号 5"：max ${bd?.scores.max.toFixed(3)} · median ${bd?.scores.median.toFixed(3)} · 返回 ${bd?.scores.aboveFloor}`);

  check('查询耗时在规模下仍然可用（平均 < 800ms）',
    results.every((r0) => r0.avgMs < 800),
    results.map((r0) => `${r0.config.label} ${r0.avgMs.toFixed(0)}ms`).join(' / '));
}

store.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上偶尔 EBUSY，不影响结论 */ }

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
