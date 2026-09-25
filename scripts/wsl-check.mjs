/**
 * Linux gate.
 *
 * Everything here is developed on Windows, and the two halves of that problem are
 * different:
 *
 *   1. Things that are WRONG on this machine right now and are invisible to git.
 *
 *      `*.sh` is declared `text eol=lf`, so `git status` converts the working copy to
 *      LF before comparing and reports "clean" — while the file on disk, the one a
 *      POSIX shell would actually execute, still has CRLF. That is how `she.sh` shipped
 *      with a `#!/usr/bin/env bash\r` shebang once already: git was happy, and the
 *      launcher died with "bad interpreter" on the only platform it exists for.
 *
 *      The exec bit is the same shape of bug. It lives in the git index, not in the
 *      Windows filesystem, so `chmod` is meaningless here and nothing complains: the
 *      file is mode 100644, and `./she.sh` on Linux is "Permission denied".
 *
 *   2. Things that need a real Linux kernel to answer.
 *
 *      This script runs the dependency-free gates inside WSL when a usable Node
 *      exists there, and otherwise says BLOCKED with the evidence and the one command
 *      that would fix it. It does not pretend a skip is a pass: a silent skip is how
 *      "we support Linux" becomes a claim nobody has checked in a year.
 *
 * Note on what WSL cannot settle either: `/mnt/d` is drvfs, which is case-insensitive
 * by default. Running the suite there does not test case sensitivity, so a Linux pass
 * from this layout is real but partial — see `docs/testing.md`.
 *
 *   node scripts/wsl-check.mjs
 *   node scripts/wsl-check.mjs --require-linux   # exit 1 when Linux could not be run
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REQUIRE_LINUX = process.argv.includes('--require-linux');

let failures = 0;
let blocked = 0;
const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 900)}`);
  }
};
const note = (label, detail) => {
  console.log(`  --    阻塞  ${label}`);
  blocked++;
  if (detail) console.log(`        ${detail}`);
};

console.log('\nLinux 门禁\n');

// ─── 1. POSIX files that git cannot tell you are broken ───
console.log('=== POSIX 文件完整性（在 Windows 上就能查）===');
{
  const posixFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (/\.(sh|bash)$/.test(entry.name) || /^Dockerfile/.test(entry.name)) posixFiles.push(p);
    }
  };
  walk(ROOT);

  const crlf = [];
  for (const f of posixFiles) {
    const bytes = readFileSync(f);
    for (let i = 1; i < bytes.length; i++) {
      if (bytes[i] === 0x0a && bytes[i - 1] === 0x0d) { crlf.push(relative(ROOT, f).replace(/\\/g, '/')); break; }
    }
  }
  check(
    `POSIX 文件在工作副本里是 LF（查了 ${posixFiles.length} 个）`,
    crlf.length === 0,
    `${crlf.join(', ')}\n        git status 看不出来（text eol=lf 会先把工作副本换算成 LF 再比较），但 POSIX shell 执行的是工作副本。`,
  );

  // The exec bit only exists in the index; on Windows it is not a file property at all.
  const shells = posixFiles.filter((f) => /\.(sh|bash)$/.test(f)).map((f) => relative(ROOT, f).replace(/\\/g, '/'));
  const notExecutable = [];
  for (const f of shells) {
    try {
      const listing = execFileSync('git', ['ls-files', '-s', '--', f], { cwd: ROOT, encoding: 'utf8' });
      const mode = listing.trim().split(/\s+/)[0];
      if (mode !== '100755') notExecutable.push(`${f} (${mode || '不在索引里'})`);
    } catch {
      notExecutable.push(`${f} (git ls-files 失败)`);
    }
  }
  check(
    `shell 脚本在 git 索引里是可执行的（${shells.length} 个）`,
    notExecutable.length === 0,
    notExecutable.join(', '),
  );

  const badShebang = shells.filter((f) => !/^#!\/(usr\/bin\/env|bin\/(ba)?sh)\b/.test(readFileSync(join(ROOT, f), 'utf8')));
  check(`shell 脚本的 shebang 可移植（${shells.length} 个）`, badShebang.length === 0, badShebang.join(', '));
}

// ─── 2. WSL: is a Linux we can actually run things in reachable? ───
console.log('\n=== WSL Linux 运行时 ===');
let distro = null;
let linuxCwd = null;
let linuxNode = null;
let wslSh = null;

const wsl = (args) => execFileSync('wsl.exe', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

if (process.platform !== 'win32') {
  note('WSL 探测', '当前不是 Windows，跳过（在 Linux 上这些检查应当直接由 CI 执行）');
} else {
  try {
    const listed = wsl(['-l', '-q']);
    distro = listed.split(/\r?\n/).map((s) => s.replace(/\0/g, '').trim()).filter(Boolean)[0] ?? null;
  } catch {
    distro = null;
  }

  if (!distro) {
    note('WSL 发行版', '没有已安装的 WSL 发行版。装一个：wsl --install -d Ubuntu');
  } else {
    console.log(`  --    发行版： ${distro}`);

    // D:\AGI\x -> /mnt/d/AGI/x
    linuxCwd = ROOT.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/');
    /*
     * `wsl.exe` writes PATH-translation noise to stderr on this machine ("Failed to
     * translate 'F:\_cursor_setup\scoop\shims'"). It is unrelated to the command, so
     * stderr goes to /dev/null and only stdout and the exit code are trusted.
     */
    wslSh = (script) => wsl(['-d', distro, '--', 'bash', '-lc', `cd ${JSON.stringify(linuxCwd)} && ${script}`]);

    const reachable = wslSh(`test -d ${JSON.stringify(linuxCwd)} && echo yes`).includes('yes');
    check(`仓库在 WSL 下可达（${linuxCwd}）`, Boolean(reachable));

    let uname = '';
    try {
      uname = wslSh('uname -srm').trim();
    } catch (e) {
      uname = `uname 失败：${e.message}`;
    }
    console.log(`  --    内核： ${uname}`);

    /*
     * Look for Node through a login shell, because nvm lives in the profile and is
     * invisible to a non-login `bash -c`.
     */
    try {
      linuxNode = wslSh(
        'n=$(command -v node 2>/dev/null); '
        + '[ -z "$n" ] && n=$(ls "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1); '
        + 'if [ -n "$n" ]; then "$n" -v; else echo none; fi',
      ).trim();
    } catch {
      linuxNode = 'none';
    }

    const version = /^v(\d+)/.exec(linuxNode)?.[1];
    if (!version || Number(version) < 20) {
      note(
        '在 WSL 里跑真实 Linux 测试',
        `WSL 里没有可用的 Node（探测结果 "${linuxNode}"，仓库要求 >= 20）。`
        + `\n        装上之后这条会自己开始跑： wsl -d ${distro} -- bash -lc "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs"`
        + '\n        注意 /mnt/d 是 drvfs，Windows 侧的 node_modules 含 win32 版 esbuild，Linux 侧需要各自安装。',
      );
    } else {
      console.log(`  --    Node： ${linuxNode}`);
      /*
       * Only the dependency-free gates run here. They are chosen because they are the
       * ones whose failure mode is platform-specific — path separators, path case,
       * `\r\n`, `os.tmpdir()` — while a test that needs tsx/esbuild would fail inside
       * WSL for reasons that have nothing to do with Linux correctness.
       */
      for (const script of ['portability-check.mjs', 'encoding-check.mjs', 'i18n-check.mjs', 'docs-check.mjs']) {
        let ok = true;
        let detail = '';
        try {
          wslSh(`node scripts/${script}`);
        } catch (e) {
          ok = false;
          detail = String(e.stdout ?? e.message).split('\n').slice(-12).join('\n        ');
        }
        check(`WSL 里 node scripts/${script}`, ok, detail);
      }
    }
  }
}

// ─── 3. Verdict ───
console.log('');
if (blocked && REQUIRE_LINUX) {
  console.log(`  FAIL  要求 Linux 验证，但有 ${blocked} 项阻塞。`);
  process.exit(1);
}
if (failures) {
  console.log(`${failures} 项失败${blocked ? `，另有 ${blocked} 项阻塞` : ''}。`);
  process.exit(1);
}
console.log(blocked
  ? `POSIX 文件检查通过；${blocked} 项 Linux 运行时验证阻塞 —— 见上面的说明，不要当成"已验证"。`
  : '全部通过。');
