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
