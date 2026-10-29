/*
 * check:maprecall —— 地图"真的能找到东西"的最小断言集（离线、不调模型）。
 *
 * 为什么单独一条：这轮修的全是"安静地答没有"的问题（3 分片上限、空符号表、按名字索引的符号表被当成路径表），
 * 而它们的共同特征是**不报错**。所以必须有一条检查能在回归时立刻变红：
 *
 *   ① 符号表非空（空表 = whereis 只剩文件名可匹配）
 *   ② 标签覆盖了绝大多数文件（缺标签 = 中文意图检索失效）
 *   ③ 符号名查询命中：planRecall → agent 目录下某个文件
 *   ④ 中文查询命中：召回 路由 → recall-router.ts
 *
 * 查的是**本仓自己的工作区**（.she/map），因为这就是用户用的那份。
 */
import { readSymbols, loadAll, mapWhereis } from '../packages/map/dist/index.js';

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
  if (!ok) failed += 1;
}

const root = process.cwd();
const loaded = loadAll(root);
if (!loaded.index) {
  console.log('地图还没建（先跑一次 map_tree）；这条检查跳过。');
  process.exit(0);
}

const symbols = readSymbols(root);
check('符号表非空', Boolean(symbols && symbols.names.length > 0),
  symbols ? `names=${symbols.names.length} arena=${symbols.arena.length}` : 'null');

const files = loaded.nodes.filter((n) => n.branch === loaded.index.branch && n.kind === 'file');
const labeled = files.filter((n) => n.label).length;
const share = files.length ? Math.round((labeled / files.length) * 100) : 0;
check('标签覆盖率 ≥95%', share >= 95, `${labeled}/${files.length}（${share}%）`);

const sym = mapWhereis(root, 'planRecall');
check('符号名查询有命中', sym.hits.length > 0,
  sym.hits.length ? sym.hits[0].path : `0 命中（扫了 ${sym.scanned}）`);

const zh = mapWhereis(root, '召回 路由');
const expect = 'recall-router.ts';
check('中文查询命中 recall-router', zh.hits.some((h) => h.path.includes(expect)),
  zh.hits.length ? zh.hits.slice(0, 3).map((h) => h.path).join(' | ') : '0 命中');

console.log(failed ? `\n${failed} 项 FAIL` : '\n全部 PASS');
process.exit(failed ? 1 : 0);
