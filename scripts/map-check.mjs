#!/usr/bin/env node
/*
 * check:map —— 项目地图的存储判据（P0 骨架，随 P1 起逐渐变严）。
 *
 * 现在还没有建图（P1 才落盘），所以"没有 store"是 PASS 而不是 FAIL：
 * 一个检查在功能还没实现时必须是绿的，否则它第一周就会被关掉。
 *
 * 一旦 `.she/map/index.json` 出现，这里逐条验：
 *   1. schemaVersion 是认识的版本；
 *   2. 分片里的文件路径真的还在 git 里（删过的文件不许留悬空节点）；
 *   3. 标签 ≤16 字（超了说明有人在把摘要塞进标签位）；
 *   4. 边的两端都指向存在的节点（悬空边会让"影响面"算错，比没边更坏）；
 *   5. `.env` / 密钥类文件零索引；
 *   6. candidate 边必须带 evidence 与 falsifiers —— "潜在威胁"不许没有据可查。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const STORE = '.she/map';
const LABEL_MAX = 16;

let failures = 0;
function ok(name, extra = '') {
  console.log(`PASS  ${name}${extra ? '  ' + extra : ''}`);
}
function fail(name, actual) {
  failures += 1;
  console.log(`FAIL  ${name}  (实际: ${actual})`);
}

const indexPath = join(STORE, 'index.json');
if (!existsSync(indexPath)) {
  ok('地图尚未建图（P1 之前属正常）', STORE + '/index.json 不存在');
  process.exit(0);
}

/** @type {any} */
let index;
try {
  index = JSON.parse(readFileSync(indexPath, 'utf8'));
} catch (err) {
  fail('index.json 可解析', err.message);
  process.exit(1);
}

if (index.schemaVersion === 1) ok('schemaVersion', '1');
else fail('schemaVersion 必须是 1', index.schemaVersion);

/** git 里真实存在的路径集合：判"悬空节点"。（--stage 顺带拿到 blob sha，但这里只要路径。） */
let tracked = null;
function trackedSet() {
  if (tracked) return tracked;
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  tracked = new Set(out.split('\0').filter(Boolean));
  return tracked;
}

const SECRET = /(^|\/)(\.env(\..*)?|.*\.(pem|key|pfx|p12)|id_rsa|id_ed25519|credentials(\.json)?)$/i;

const nodeKeys = new Set();
/** 边的两端存的是纯路径（不带分支前缀），所以悬空边必须按路径判。 */
const nodePaths = new Set();
const files = [];

for (const shard of index.shards ?? []) {
  const file = join(STORE, `shard-${shard.key}.json`);
  if (!existsSync(file)) {
    fail(`分片存在: ${shard.key}`, 'index 里登记了但文件不在');
    continue;
  }
  /** @type {any} */
  const data = JSON.parse(readFileSync(file, 'utf8'));
  for (const node of data.nodes ?? []) {
    const key = `${node.branch}:${node.path}`;
    if (nodeKeys.has(key)) fail(`节点唯一: ${key}`, '同一分支同一路径出现两次（孪生体应跨分支，不是同分支重复）');
    nodeKeys.add(key);
    nodePaths.add(node.path);
    if (node.kind === 'file') files.push(node);
  }
}

if (files.length === 0) {
  ok('分片里有文件节点', '0（空图，P1 尚未跑）');
}

const git = trackedSet();
const dangling = files.filter((n) => !git.has(n.path));
if (dangling.length === 0) ok('文件节点都在 git 里', `${files.length} 个`);
else fail('文件节点都在 git 里', `${dangling.length} 个悬空，例如 ${dangling.slice(0, 3).map((n) => n.path).join(', ')}`);

const leaks = files.filter((n) => SECRET.test(n.path));
if (leaks.length === 0) ok('敏感文件零索引', '未发现 .env / 密钥类路径');
else fail('敏感文件零索引', leaks.slice(0, 3).map((n) => n.path).join(', '));

const longLabels = files.filter((n) => n.label && [...n.label].length > LABEL_MAX);
if (longLabels.length === 0) ok(`标签 ≤${LABEL_MAX} 字`, '全部合规');
else fail(`标签 ≤${LABEL_MAX} 字`, `${longLabels.length} 个超长，例如 "${longLabels[0].label}"`);

for (const shard of index.shards ?? []) {
  const file = join(STORE, `shard-${shard.key}.json`);
  if (!existsSync(file)) continue;
  /** @type {any} */
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const danglingEdges = (data.edges ?? []).filter((e) => !nodePaths.has(e.from) || !nodePaths.has(e.to));
  if (danglingEdges.length === 0) ok(`分片 ${shard.key} 无悬空边`, `${(data.edges ?? []).length} 条`);
  else fail(`分片 ${shard.key} 无悬空边`, `${danglingEdges.length} 条悬空，例如 ${danglingEdges[0].from} → ${danglingEdges[0].to}`);

  const badCandidates = (data.edges ?? []).filter(
    (e) => e.confidence === 'candidate' && (!Array.isArray(e.evidence) || e.evidence.length === 0 || !Array.isArray(e.falsifiers) || e.falsifiers.length === 0),
  );
  if (badCandidates.length === 0) ok(`分片 ${shard.key} 的 candidate 边都有证据与反证条件`, 'ok');
  else fail(`分片 ${shard.key} 的 candidate 边都有证据与反证条件`, `${badCandidates.length} 条缺失`);
}

const shardFiles = existsSync(STORE) ? readdirSync(STORE).filter((f) => f.startsWith('shard-')) : [];
if (shardFiles.length === (index.shards ?? []).length) ok('index 与分片文件数一致', `${shardFiles.length}`);
else fail('index 与分片文件数一致', `index ${(index.shards ?? []).length} 个，磁盘 ${shardFiles.length} 个`);

/*
 * 闸门表守卫：表里写的 check 必须在本仓 package.json 里存在。
 * 表过期比没有表更坏——模型会去跑一个不存在的命令。
 */
try {
  const { GATE_RULES } = await import('../packages/map/dist/index.js');
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts ?? {};
  const missing = new Set();
  for (const rule of GATE_RULES) for (const c of rule.checks) if (!(c in scripts)) missing.add(c);
  if (missing.size === 0) ok('闸门表里的 check 都存在', `${GATE_RULES.length} 条规则`);
  else fail('闸门表里的 check 都存在', `不存在的: ${[...missing].join(', ')}`);
} catch {
  ok('闸门表守卫（跳过）', 'packages/map/dist 尚未构建');
}

if (failures > 0) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
