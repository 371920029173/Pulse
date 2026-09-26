/**
 * Stage a runnable desktop runtime for electron-builder extraResources.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `--node-linker=hoisted` IS LOAD-BEARING
 *
 * The runtime is installed with `pnpm deploy`. By default pnpm produces a virtual store: each
 * package lives under `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>` and its DEPENDENCIES ARE
 * SIBLINGS of it, reached through symlinks at the top level.
 *
 * The previous version resolved all of that to plain directories (a Python `copytree` with
 * `symlinks=False`, then deleting the original) so that electron-builder could copy it. That
 * silently destroys the layout the resolution depends on: after dereferencing, `@she/shared` is a
 * real directory whose `node_modules` does NOT contain its dependencies — they were its siblings in
 * the virtual store, and they stay behind. Node then cannot resolve them, and the packaged app dies
 * on startup with `ERR_MODULE_NOT_FOUND`.
 *
 * It went unnoticed because `@she/shared` used to have no runtime dependencies at all, so no
 * workspace package ever needed to resolve a third-party module from the packaged tree. Adding one
 * (`yaml`, when the hand-rolled YAML parser was replaced) turned a latent breakage into a broken
 * installer.
 *
 * `--node-linker=hoisted` produces a flat, symlink-free `node_modules` — which is what a packaged
 * application actually needs. There is nothing left to flatten, so the Python dependency is gone
 * too (a portability win: the build no longer requires python on the machine).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import {
  cpSync, mkdirSync, rmSync, existsSync, copyFileSync, writeFileSync,
  readFileSync, appendFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const RUNTIME = join(ROOT, 'packages', 'desktop', 'runtime');
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(cmd, args, cwd = ROOT) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
}

console.log('Staging desktop runtime…');
rmSync(RUNTIME, { recursive: true, force: true });
mkdirSync(RUNTIME, { recursive: true });

run(PNPM, ['-r', 'build']);

const npmrc = join(ROOT, '.npmrc');
const prev = existsSync(npmrc) ? readFileSync(npmrc, 'utf8') : '';
if (!prev.includes('inject-workspace-packages')) {
  appendFileSync(npmrc, '\ninject-workspace-packages=true\n', 'utf8');
}

const serverOut = join(RUNTIME, 'server');
run(PNPM, ['--filter', '@she/server', 'deploy', serverOut, '--prod', '--node-linker=hoisted']);

const uiSrc = join(ROOT, 'packages', 'ui', 'dist');
if (!existsSync(join(uiSrc, 'index.html'))) throw new Error('ui dist missing');
cpSync(uiSrc, join(RUNTIME, 'ui'), { recursive: true });

// `skills/` is the version-controlled copy; `.she/skills` is the legacy location.
const skillsSrc = existsSync(join(ROOT, 'skills')) ? join(ROOT, 'skills') : join(ROOT, '.she', 'skills');
if (existsSync(skillsSrc)) cpSync(skillsSrc, join(RUNTIME, 'skills'), { recursive: true });
else mkdirSync(join(RUNTIME, 'skills'), { recursive: true });

copyFileSync(process.execPath, join(RUNTIME, 'node.exe'));
writeFileSync(join(RUNTIME, 'README.txt'), 'Pulse desktop runtime — do not edit\n', 'utf8');
console.log('Runtime staged at', RUNTIME);

/*
 * Refuse to ship a runtime carrying anything but the product.
 *
 * `pnpm deploy` copies the package directory, so whatever sits in `packages/server` at build time
 * ends up inside the installer. That is not theoretical: an earlier build shipped the author's
 * `.she/` (knowledge base, session list), a `.playwright-mcp/` page snapshot, the TypeScript
 * sources, and a `packages/` tree that a previous packaging run had nested into itself. Nobody was
 * reading any of it — the launcher points SHE_WORKSPACE at the user's own folder — so the failure
 * was silent in both directions: extra weight in every artifact, and someone else's data
 * distributed with it.
 *
 * `files: ["dist"]` in the server manifest is the fix; this is the ratchet. It fails the build
 * rather than warning, because a warning here is read after the installer has been published.
 */
const FORBIDDEN = [
  ['.she', '开发期的运行时状态（知识库 / 会话记录）'],
  ['.playwright-mcp', 'MCP 页面快照'],
  ['src', 'TypeScript 源码（运行时只读 dist）'],
  ['packages', '上一次打包残留的自嵌套目录'],
  ['tsconfig.tsbuildinfo', '构建缓存'],
  ['tsconfig.json', '构建配置'],
  ['.env', '本机密钥'],
];
const shipped = [];
for (const [name, why] of FORBIDDEN) {
  const p = join(serverOut, name);
  if (existsSync(p)) shipped.push(`${name}  (${why})`);
}
if (shipped.length) {
  console.error('\n运行时里混进了不该发布的东西：');
  for (const s of shipped) console.error(`  - ${s}`);
  console.error('\n应在 packages/server/package.json 的 files 里排除，而不是在构建后手工删。');
  process.exit(1);
}
console.log(`运行时干净：只有 dist（已排除 ${FORBIDDEN.map(([n]) => n).join(' / ')}）`);
