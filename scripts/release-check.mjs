/**
 * Does the released archive actually work?
 *
 * Packaging that produces a file is not packaging that produces something runnable.
 * This extracts the archive to a clean directory and checks that every file the app
 * needs at startup is present — the launcher, the workspace manifests, the source
 * packages, and the scripts the launcher calls into.
 *
 * What it cannot check is a real install (`pnpm install` + build + boot), because
 * that needs the network and several minutes. The structural check catches the
 * failure that actually happens when assembling an archive by hand: a file is left
 * out because it was not in the copy list.
 *
 *   node scripts/release-check.mjs
 */
import {
  existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, statSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RELEASE_DIR = join(ROOT, 'release');

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 300)}`);
  }
};

console.log('\n发布包检查\n');

if (!existsSync(RELEASE_DIR)) {
  check('存在 release 目录', false, '先运行 node scripts/release.mjs');
  console.log('\n1 项失败');
  process.exit(1);
}

const archives = readdirSync(RELEASE_DIR).filter((f) => /\.(zip|tar\.gz)$/.test(f));
if (archives.length === 0) {
  check('存在归档文件', false, `release/ 里只有: ${readdirSync(RELEASE_DIR).join(', ')}`);
  console.log('\n1 项失败');
  process.exit(1);
}

const archive = archives.find((f) => f.endsWith('.tar.gz')) ?? archives[0];
const archivePath = join(RELEASE_DIR, archive);
console.log(`  归档: ${archive}  ${(statSync(archivePath).size / 1024 / 1024).toFixed(1)} MB\n`);

// ─── Extract into a clean directory ───
const tmp = mkdtempSync(join(tmpdir(), 'she-release-'));
let root = null;

try {
  execFileSync('tar', ['-xzf', archivePath, '-C', tmp], { stdio: 'pipe' });
  const entries = readdirSync(tmp);
  root = join(tmp, entries[0]);

  console.log('=== 归档结构 ===');
  check('解压出单个顶层目录', entries.length === 1, entries.join(', '));
  if (!existsSync(root)) throw new Error('解压目录不存在');

  const has = (rel) => existsSync(join(root, rel));

  // ─── What the first launch needs ───
  console.log('\n=== 首次启动所需文件 ===');
  // shell
  for (const f of ['she.sh', 'SHE.bat', 'SHE-stop.bat']) {
    check(`启动器 ${f}`, has(f));
  }
  check('共享启动逻辑 scripts/she.mjs', has('scripts/she.mjs'));
  check('启动提示文案 scripts/launcher-messages.json', has('scripts/launcher-messages.json'));

  // manifests
  for (const f of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json']) {
    check(`清单 ${f}`, has(f));
  }

  // Every workspace package, with the manifest and the source the first build needs.
  console.log('\n=== 工作区包 ===');
  {
    const missing = [];
    const pkgRoot = join(ROOT, 'packages');
    for (const dir of readdirSync(pkgRoot)) {
      const manifest = join(pkgRoot, dir, 'package.json');
      if (!existsSync(manifest)) continue;
      if (!has(join('packages', dir, 'package.json'))) { missing.push(`${dir}/package.json`); continue; }

      /*
       * Source, in whichever shape the package uses. Most compile from `src/`, but
       * the desktop shell is plain CommonJS at the package root (`main.cjs`,
       * `preload.cjs`) — requiring `src/` everywhere reported a complete archive as
       * broken.
       */
      const extracted = join(root, 'packages', dir);
      const hasSrc = existsSync(join(extracted, 'src'));
      const hasRootSource = readdirSync(extracted).some((f) => /\.(cjs|mjs|js|ts)$/.test(f));
      if (!hasSrc && !hasRootSource) missing.push(`${dir}/(源码)`);
    }
    check(`全部包的 manifest 与源码都在（${missing.length} 处缺失）`, missing.length === 0, missing.join(', '));
  }

  // ─── Documentation and licensing ───
  console.log('\n=== 随包文档 ===');
  for (const f of ['README.md', 'LICENSE', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md']) {
    check(f, has(f));
  }
  check('发布清单 release-manifest.json', has('release-manifest.json'));

  // ─── What must NOT be in it ───
  console.log('\n=== 不该进包的东西 ===');
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { out.push(e.name + '/'); walk(p, out); continue; }
      out.push(e.name);
    }
    return out;
  };
  const all = walk(root);

  check('没有 node_modules', !all.includes('node_modules/'));
  check('没有 dist 产物（首次启动会重建）', !all.includes('dist/'));
  check('没有 .she 本机状态', !all.includes('.she/'));
  check('没有 .env（密钥）', !all.includes('.env'));
  check('没有 .env.example 之外的 env 文件', all.filter((f) => f.startsWith('.env') && f !== '.env.example').length === 0,
    all.filter((f) => f.startsWith('.env')).join(', '));
  check('没有测试文件', !all.some((f) => /\.test\.(ts|tsx)$/.test(f)));
  check('没有 __tests__ 目录', !all.includes('__tests__/'));

  // ─── The manifest tells the truth ───
  console.log('\n=== 发布清单内容 ===');
  {
    const m = JSON.parse(readFileSync(join(root, 'release-manifest.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    check('清单版本与 package.json 一致', m.version === pkg.version, `${m.version} vs ${pkg.version}`);
    check('记录了构建时间', typeof m.builtAt === 'string' && m.builtAt.length > 0);
    check('记录了提交号', typeof m.commit === 'string' || m.commit === null);
    check('记录了是否跑过检查', typeof m.checksRan === 'boolean');
    console.log(`        版本 ${m.version}  文件 ${m.fileCount}  检查 ${m.checksRan ? '已跑' : '未跑'}`);
  }

  // ─── The archive is plausibly installable ───
  console.log('\n=== 可安装性（静态） ===');
  {
    const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    check('根 package.json 声明了 packageManager（否则 corepack 无法复现）',
      typeof rootPkg.packageManager === 'string', String(rootPkg.packageManager));
    check('根 package.json 声明了 engines.node', !!rootPkg.engines?.node);
    check('scripts.check:all 可用（新克隆能自查）', typeof rootPkg.scripts?.['check:all'] === 'string');

    // The lockfile must list every workspace importer, or --frozen-lockfile fails.
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    const importers = ['packages/server', 'packages/ui', 'packages/shared', 'packages/kb'];
    const missingImporters = importers.filter((i) => !lock.includes(`${i}:`));
    check('lockfile 覆盖关键包（--frozen-lockfile 才不会失败）',
      missingImporters.length === 0, missingImporters.join(', '));
  }
} catch (err) {
  check('检查过程未抛异常', false, err.stack ?? err.message);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n注意：这是结构检查。真正的验证需要在干净目录里');
console.log('      `pnpm install && ./she.sh`，会用到网络并需要几分钟。');
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
