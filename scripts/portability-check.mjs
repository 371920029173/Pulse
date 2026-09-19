/**
 * Portability check.
 *
 * The project claims it runs on macOS/Linux, but every automated test so far has
 * been written and run on Windows. Nothing catches a newly added `taskkill`,
 * `cmd.exe`, or hardcoded `C:\` path until a user on another platform hits it.
 *
 * This does not prove the code works elsewhere — only a real run can do that.
 * It catches the failure that actually happens in practice: a platform-specific
 * call being added without a branch for the other platform.
 *
 * Escape hatch: a line containing `portability-check:allow` is skipped, for the
 * legitimate cases (hostile-path fixtures, deliberate platform probing).
 *
 *   node scripts/portability-check.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
let failures = 0;
let checked = 0;

const check = (label, cond, detail) => {
  checked++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
};

/** Source files we ship, excluding build output and dependencies. */
function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { sourceFiles(p, out); continue; }
    if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = [
  ...sourceFiles(join(ROOT, 'packages')),
  ...sourceFiles(join(ROOT, 'scripts')),
];
console.log(`扫描 ${files.length} 个源文件\n`);

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');
const read = (p) => readFileSync(p, 'utf8');

/**
 * Blank out comments.
 *
 * Without this, mentions of a platform-specific command inside explanatory prose
 * trip the very rule the prose is explaining — which is how a check starts
 * producing noise and gets ignored.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(\/\/|\*|#).*$/, (m) => ' '.repeat(m.length)))
    .join('\n');
}

const OPT_OUT = 'portability-check:allow';
const stripped = new Map(files.map((f) => [f, stripComments(read(f)).split(/\r?\n/)]));
const rawLines = new Map(files.map((f) => [f, read(f).split(/\r?\n/)]));

/**
 * Comment-stripped lines, with opted-out lines blanked.
 *
 * The directive covers the following few lines, so a short fixture block can
 * carry one note instead of a marker on every line.
 */
function clean(f) {
  const cooked = stripped.get(f);
  const raw = rawLines.get(f);
  const OPT_OUT_SPAN = 4;
  return cooked.map((line, i) => {
    for (let back = 0; back <= OPT_OUT_SPAN; back++) {
      if ((raw[i - back] ?? '').includes(OPT_OUT)) return ' '.repeat(line.length);
    }
    return line;
  });
}

// ─── 1. Windows-only syscalls must sit inside a platform branch ───
//
// Deliberately matches named commands only. A bare `.exe` is usually a file
// EXTENSION in an allowlist (binary assets, for instance), not an invocation.
console.log('=== Windows 专有调用是否都有分支 ===');
{
  const windowsOnly = /\b(taskkill|tasklist|cmd\.exe|powershell\.exe|COMSPEC)\b/;
  const branchMarkers = /process\.platform|IS_WINDOWS|IS_MAC|darwin|win32|PATHEXT|findOnPath|\.bin/;
  const offenders = [];

  for (const f of files) {
    const src = clean(f);
    src.forEach((line, i) => {
      if (!windowsOnly.test(line)) return;
      // A reasonable window: the branch and the call are often a few lines apart.
      const window = src.slice(Math.max(0, i - 12), Math.min(src.length, i + 12)).join('\n');
      if (!branchMarkers.test(window)) {
        offenders.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 100)}`);
      }
    });
  }
  check(
    `Windows 专有调用都有平台分支 (${offenders.length} 处可疑)`,
    offenders.length === 0,
    offenders.slice(0, 6).join('\n        '),
  );
}

// ─── 2. No absolute Windows paths baked into shipped source ───
console.log('\n=== 是否有硬编码的盘符路径 ===');
{
  const offenders = [];
  for (const f of files) {
    clean(f).forEach((line, i) => {
      // A drive-letter literal in code breaks every other platform. A user-data
      // default is the worst case: it ships to everyone and silently points at a
      // drive that does not exist.
      if (/['"`][A-Za-z]:[\\/]/.test(line)) {
        offenders.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 100)}`);
      }
    });
  }
  check(
    `没有硬编码的 Windows 盘符路径 (${offenders.length} 处)`,
    offenders.length === 0,
    offenders.slice(0, 6).join('\n        '),
  );
}

// ─── 3. Launcher exists for every platform ───
console.log('\n=== 启动器覆盖情况 ===');
{
  const wrappers = [
    ['she.sh', 'POSIX (macOS/Linux)'],
    ['SHE.bat', 'Windows'],
    ['SHE-stop.bat', 'Windows stop'],
    [join('scripts', 'she.mjs'), 'shared logic'],
  ];
  for (const [p, label] of wrappers) {
    check(`${p} 存在 (${label})`, existsSync(join(ROOT, p)));
  }

  if (existsSync(join(ROOT, 'she.sh'))) {
    const sh = read(join(ROOT, 'she.sh'));
    check('she.sh 调用共享逻辑 she.mjs', sh.includes('she.mjs'));
    check('she.sh 只有薄薄一层包装（没有重复业务逻辑）', sh.split('\n').length < 45,
      `${sh.split('\n').length} 行`);
  }
  if (existsSync(join(ROOT, 'SHE.bat'))) {
    const bat = read(join(ROOT, 'SHE.bat'));
    check('SHE.bat 调用共享逻辑 she.mjs', bat.includes('she.mjs'));
    // The old .bat broke because one non-ASCII byte changed its PARSING, not
    // just its output. Nothing non-ASCII may live in it.
    check('SHE.bat 是纯 ASCII', /^[\x00-\x7F]*$/.test(bat));
  }
  // Messages must be readable on any platform, so they live in JSON.
  const msgFile = join(ROOT, 'scripts', 'launcher-messages.json');
  if (existsSync(msgFile)) {
    const bytes = readFileSync(msgFile);
    // A BOM makes JSON.parse throw, which silently downgrades all messages to
    // English (this happened once).
    check('launcher-messages.json 无 BOM',
      !(bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF));
  }
}

// ─── 4. Process termination has a branch per platform ───
console.log('\n=== 进程终止的分平台处理 ===');
{
  const shellTs = join(ROOT, 'packages', 'sandbox', 'src', 'shell.ts');
  if (existsSync(shellTs)) {
    const src = read(shellTs);
    check('sandbox 在 POSIX 上用进程组终止', /process\.kill\(-child\.pid/.test(src));
    check('sandbox 在 Windows 上用 taskkill', /taskkill/.test(src));
    // detached on POSIX is what CREATES the process group that makes the
    // group-kill above work; without it a killed shell leaves children running.
    check('sandbox 用 detached 建立进程组', /detached:\s*!IS_WINDOWS/.test(src));
  } else {
    check('sandbox/src/shell.ts 存在', false, shellTs);
  }

  const launcher = join(ROOT, 'scripts', 'she.mjs');
  if (existsSync(launcher)) {
    // Comments are stripped first: the explanation of why we DON'T use these
    // tools would otherwise fail the assertion that we don't use them.
    const src = stripComments(read(launcher));
    check('launcher 用 pidfile 记录 PID（不依赖 netstat/lsof）',
      src.includes('server.pid') && !/netstat|lsof|Get-NetTCPConnection/.test(src));
    check('launcher 分平台终止进程树',
      /taskkill/.test(src) && /process\.kill\(-pid/.test(src));
    check('launcher 分平台打开浏览器',
      /xdg-open/.test(src) && /darwin/.test(src) && /'start'/.test(src));
    // Piping a detached child's output through the launcher kills it when the
    // launcher exits; the fds must be handed over instead.
    check('launcher 不通过管道转发子进程输出',
      !/stdio:\s*\['ignore',\s*'pipe'/.test(src));
  }
}

// ─── 5. Path comparisons case-fold on Windows ───
console.log('\n=== Windows 路径大小写处理 ===');
{
  const containment = join(ROOT, 'packages', 'server', 'src', 'index.ts');
  if (existsSync(containment)) {
    const src = read(containment);
    check('工作区越界判断在 Windows 上折叠大小写',
      /win32'[^\n]*toLowerCase/s.test(src) || /toLowerCase\(\)[^\n]*win32/s.test(src));
  }
  const lsp = join(ROOT, 'packages', 'agent-runtime', 'src', 'lsp-client.ts');
  if (existsSync(lsp)) {
    const src = read(lsp);
    // Drive-letter case differs between us (`D:\`) and a server's URI (`file:///d%3A`).
    // `Map` keys are case-sensitive, so without folding, diagnostics silently
    // never arrive. Easy to delete by accident.
    check('LSP 的按文件索引在 Windows 上折叠大小写', /fileKey/.test(src));
    check('LSP 的 fileKey 确实折叠大小写', /win32'\s*\?\s*\w+\.toLowerCase\(\)/.test(src));
  }
}

// ─── 6. Reverse direction: POSIX-only assumptions ───
console.log('\n=== 反向：POSIX 专有假设 ===');
{
  const offenders = [];
  for (const f of files) {
    clean(f).forEach((line, i) => {
      if (!/['"`]\/(bin|usr|etc|tmp|opt)\//.test(line)) return;
      const window = clean(f).slice(Math.max(0, i - 6), i + 6).join('\n');
      if (!/platform|darwin|linux|IS_WINDOWS|IS_MAC|xdg|posix/i.test(window)) {
        offenders.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 100)}`);
      }
    });
  }
  check(
    `没有未分支的 POSIX 绝对路径 (${offenders.length} 处)`,
    offenders.length === 0,
    offenders.slice(0, 6).join('\n        '),
  );
}

// ─── 7. Nothing that ships may point at the author's machine ───
console.log('\n=== 是否残留开发者个人环境 ===');
{
  const personal = /[A-Za-z]:[\\/](AGI|Users[\\/]Administrator)\b/i;
  const offenders = [];
  for (const f of files) {
    clean(f).forEach((line, i) => {
      if (personal.test(line)) {
        offenders.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 100)}`);
      }
    });
  }
  check(
    `没有指向开发者本机路径 (${offenders.length} 处)`,
    offenders.length === 0,
    offenders.slice(0, 6).join('\n        '),
  );
}

console.log(`\n本机平台: ${process.platform} ${process.arch}`);
console.log('注意：这只能证明"没有明显的平台专有代码"，不能替代在 macOS/Linux 上的实际运行。');
console.log(`${failures === 0 ? `全部通过（${checked} 项）` : `${failures}/${checked} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
