/**
 * @she/kb 能不能真被外人装上、跑起来：pack 两个包 → 装进空项目 → import → 跑一次 query。
 *
 * 为什么不在 check:offline 里：它要用网络（npm 装包 + better-sqlite3 的预编译包）。
 * 与 check:deps 同一个理由 —— 那一整套的契约是一步都不出网，掺进网络步骤就没法每次本地跑。
 *
 * 为什么两个包一起 pack：@she/kb 依赖 @she/shared（`workspace:*`），打包时会被写成版本号。
 * 只发布 @she/kb 的话，装它的人会去 registry 找一个并不存在的 @she/shared —— 这一步就是把
 * 「发布顺序」这件事摆到台面上。
 *
 *   node scripts/kb-pack-check.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { removeTempDir } from './lib/temp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) { failures++; if (detail !== undefined) console.log(`        ${String(detail).slice(0, 800)}`); }
};

const dir = mkdtempSync(join(tmpdir(), 'she-kbpack-'));
let consumer = '';

try {
  console.log('\n1. pack 两个包');
  const tarballs = [];
  for (const pkg of ['packages/shared', 'packages/kb']) {
    const out = execFileSync('pnpm', ['pack', '--pack-destination', dir], { cwd: join(ROOT, pkg), encoding: 'utf8', shell: true });
    // pnpm pack 打印的是绝对路径；只有它给相对名时才需要拼到 dir 上（join 不会因绝对段而重置）。
    const produced = out.trim().split(/\r?\n/).filter(Boolean).pop();
    const tarball = isAbsolute(produced) ? produced : join(dir, produced);
    tarballs.push(tarball);
    console.log(`   ${pkg} → ${tarball}`);
  }
  // 断言它真的存在、且非空 —— 之前那版用尾段比对是恒真的假 PASS。
  check('两个 tarball 都在（且非空）', tarballs.every((x) => existsSync(x) && statSync(x).size > 0),
    tarballs.map((x) => (existsSync(x) ? `${x}（${statSync(x).size}B）` : `${x}（不存在）`)).join(', '));

  console.log('\n2. 装进一个空项目（只有 package.json）');
  consumer = join(dir, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(join(consumer, 'package.json'),
    JSON.stringify({ name: 'kb-consumer', private: true, type: 'module' }, null, 2), 'utf8');
  // 相对路径的 file: 规格：Windows 下把绝对路径交给 npm，它会再拼一次 cwd，报 tarball 损坏。
  const specs = tarballs.map((x) => 'file:' + relative(consumer, x).split('\\').join('/'));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', ...specs], { cwd: consumer, stdio: 'pipe', shell: true });
  check('装上了（两个 tarball + better-sqlite3 的依赖树）', true);

  console.log('\n3. import 并跑一次 query（这就是判据）');
  writeFileSync(join(consumer, 'run.mjs'), [
    "import { mkdirSync } from 'node:fs';",
    "import { loadConfig } from '@she/shared';",
    "import { KBStore, GroupKBEngine } from '@she/kb';",
    '',
    "const ws = new URL('./ws/', import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, '$1');",
    "mkdirSync(ws, { recursive: true });",
    "const config = loadConfig(ws);",
    "const store = new KBStore(ws + '/kb.sqlite');",
    "const engine = new GroupKBEngine(store, config.kb);",
    "const group = engine.createGroup('project/decisions');",
    "store.createMemory({",
    "  kind: 'fact',",
    "  groupIds: [group.id],",
    "  title: '为什么不上向量检索',",
    "  content: '词的入口用 BM25、关系召回沿组图传播；引入 embedding 会让检索不可解释，而激活轨迹正是这个库要给出的东西。',",
    "});",
    "const result = engine.query('检索为什么不用向量', { budget: 5 });",
    "console.log('RESULT ' + JSON.stringify({",
    "  nodes: result.nodes.length,",
    "  first: result.nodes[0]?.title ?? null,",
    "  traces: result.traces.length,",
    "  tracePath: result.traces[0]?.groupPath ?? null,",
    "}));",
  ].join('\n'), 'utf8');
  const out = execFileSync('node', ['run.mjs'], { cwd: consumer, encoding: 'utf8' });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('RESULT ')) ?? '';
  const parsed = line ? JSON.parse(line.slice('RESULT '.length)) : null;
  console.log(`   ${line}`);
  check('import 成功并且查询跑通了', parsed !== null, out.slice(-600));
  check('查得到刚写进去的那条记忆', parsed?.nodes >= 1 && parsed?.first === '为什么不上向量检索',
    JSON.stringify(parsed));
  check('结果带着激活轨迹（组路径）', parsed?.traces >= 1 && Array.isArray(parsed?.tracePath) && parsed.tracePath.length > 0,
    JSON.stringify(parsed));
} catch (e) {
  check('脚本自身没有抛异常', false, e?.stderr?.toString?.() ?? e?.stack ?? String(e));
} finally {
  console.log(`\n${failures === 0 ? 'PASS  kb-pack-check' : `FAIL  kb-pack-check（${failures} 条）`}\n`);
  if (consumer) { try { console.log(`  临时项目：${consumer}`); } catch { /* 忽略 */ } }
  if (failures === 0) removeTempDir(dir);
  process.exit(failures === 0 ? 0 : 1);
}
