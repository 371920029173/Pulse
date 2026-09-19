/**
 * Stage a runnable desktop runtime for electron-builder extraResources.
 */
import {
  cpSync, mkdirSync, rmSync, existsSync, copyFileSync, writeFileSync,
  readFileSync, appendFileSync, renameSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

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
run(PNPM, ['--filter', '@she/server', 'deploy', serverOut]);

const flat = join(RUNTIME, 'server-flat');
rmSync(flat, { recursive: true, force: true });
const flattenPy = join(RUNTIME, '_flatten.py');
writeFileSync(
  flattenPy,
  'import shutil\nfrom pathlib import Path\n'
  + `shutil.copytree(Path(r"${serverOut.replace(/\\/g, '\\\\')}"), Path(r"${flat.replace(/\\/g, '\\\\')}"), symlinks=False, ignore_dangling_symlinks=True)\n`,
  'utf8',
);
const r = spawnSync('python', [flattenPy], { stdio: 'inherit', shell: true });
rmSync(flattenPy, { force: true });
if (r.status) throw new Error('flatten failed');
rmSync(serverOut, { recursive: true, force: true });
renameSync(flat, serverOut);

const uiSrc = join(ROOT, 'packages', 'ui', 'dist');
if (!existsSync(join(uiSrc, 'index.html'))) throw new Error('ui dist missing');
cpSync(uiSrc, join(RUNTIME, 'ui'), { recursive: true });

const skillsSrc = join(ROOT, '.she', 'skills');
if (existsSync(skillsSrc)) cpSync(skillsSrc, join(RUNTIME, 'skills'), { recursive: true });
else mkdirSync(join(RUNTIME, 'skills'), { recursive: true });

copyFileSync(process.execPath, join(RUNTIME, 'node.exe'));
writeFileSync(join(RUNTIME, 'README.txt'), 'Pulse desktop runtime — do not edit\n', 'utf8');
console.log('Runtime staged at', RUNTIME);
