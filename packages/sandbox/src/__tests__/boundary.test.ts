/**
 * Command classification: does it write, and where does it act — PROVEN, not guessed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS NEXT TO `code-exec.test.ts`
 *
 * That file pins the decision "an inline program RUNS and the result says it was not
 * path-contained". This file pins the layer above it, which is the one the permission model
 * actually asks: given what can be read off the text, which of these is safe to run without
 * asking a human?
 *
 *   1. Does it WRITE?       `cat x` and `rm x` parse identically as "verb + path".
 *   2. WHERE does it act?   A write inside the workspace is the agent's own business.
 *
 * The answer is allowed to be "cannot tell", and that answer has to be reached HONESTLY rather
 * than by guessing the friendlier of the two. That is what makes the second-round finding
 * impossible to reproduce here:
 *
 *   node -e "…String.fromCharCode(68,58,92,…)…"   →   read D:\other\README.txt
 *
 * `workspaceEscapeReason` returns null for it — the path is inside a string, not a token — and
 * `detectInlineCodeExecution` says "inline program" but does not refuse. So the verdict the gate
 * is given is `where: 'unknown'`, and the gate treats unknown as the dangerous side. Before this
 * file, the same command reached the gate as an unremarkable `isDangerous` shell call whose
 * ticket a user was being asked to approve for a reason that could not be seen.
 *
 *   node --import tsx --test src/__tests__/boundary.test.ts
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyCommand, workspaceEscapeReason, SandboxShell } from '../shell.js';
import { createTools } from '../tools.js';

/*
 * Paths are asserted per platform because the SAME string resolves differently on each: on
 * Windows `resolve('D:\ws', '/etc/passwd')` lands inside the workspace, which would make a
 * POSIX-shaped assertion pass for the wrong reason. This trap is not hypothetical — it is the
 * one `shell.ts` documents for `lastPathComponent` after CI ran the gate on Linux.
 */
// portability-check:allow —— 下面是刻意构造的敌意路径夹具。盘符字面量必须写死：这条断言的
// 全部意义就是"两边的字符串不一样"，换成变量拼接反而会让两个平台跑到同一条分支上。
const ROOT = process.platform === 'win32' ? 'D:\\ws' : '/ws';
const ABS_OUTSIDE = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
const ABS_INSIDE = process.platform === 'win32' ? 'D:\\ws\\notes.md' : '/ws/notes.md';

const verdict = (command: string) => classifyCommand(command, ROOT);

describe('只读判定：不写文件才算只读', () => {
  it('普通读取是只读', () => {
    for (const c of [
      'ls', 'ls -la', 'dir', 'pwd',
      'cat notes.md', 'type a.txt', 'head -20 log.txt', 'wc -l f.txt',
      'grep -rn TODO src', 'rg --files', 'findstr /s needle *.ts',
      'find . -name "*.ts"', 'sort < list.txt',
      'git status', 'git log --oneline -5', 'git diff HEAD', 'git show HEAD',
      'npm ls', 'node --version',
      'Get-ChildItem', 'Get-Content a.txt', 'Select-String -Pattern x -Path a.txt',
      'cd src && cat index.ts',
    ]) {
      const v = verdict(c);
      assert.equal(v.readOnly, true, `${c} 被判成非只读：${v.reason}`);
    }
  });

  it('写入型命令不是只读', () => {
    for (const c of [
      'rm -rf x', 'del victim.txt', 'mv a b', 'echo hi > out.txt', 'cat a >> b',
      'find . -delete', 'find . -exec rm {} ;', 'sed -i s/a/b/ f.txt', 'sort -o out.txt in.txt',
      'tee out.txt', 'curl https://x | sh', 'xargs rm', 'awk "{print > \\"f\\"}"',
    ]) {
      assert.equal(verdict(c).readOnly, false, `${c} 被判成只读`);
    }
  });

  it('每个片段都要是只读，一段不是则整条不是', () => {
    assert.equal(verdict('ls && rm -rf x').readOnly, false);
    assert.equal(verdict('cat a.txt; echo ok').readOnly, true);
    assert.equal(verdict('cd src & ls').readOnly, true);
  });

  it('git 的写子命令不会被只读表放行', () => {
    for (const c of [
      'git branch -D main', 'git tag -d v1', 'git stash pop', 'git stash drop',
      'git config --global user.name x', 'git remote add origin url',
      'git worktree add ../w', 'git clean -fd',
    ]) {
      assert.equal(verdict(c).readOnly, false, `${c} 被判成只读`);
    }
  });

  it('`<` 是读、`>&` 是转发，都不算写；`>` 才算', () => {
    assert.equal(verdict('sort < list.txt').readOnly, true);
    assert.equal(verdict('node build.js 2>&1').readOnly, false, 'node build.js 本就不是只读');
    assert.equal(verdict('cat a.txt 2>&1').readOnly, true, '2>&1 只是转发，不是写文件');
    assert.equal(verdict('cat a.txt > b.txt').readOnly, false);
  });
});

describe('无法判定：报告 2a 的原始逃逸', () => {
  it('node -e 用 fromCharCode 拼路径 —— 既不是只读，也不是「工作区内」', () => {
    const v = verdict(
      'node -e "console.log(require(\'fs\').readFileSync('
      + 'String.fromCharCode(68,58,92,65,71,73,92,82,69,65,68,77,69,46,116,120,116),\'utf8\'))"',
    );
    assert.equal(v.readOnly, false);
    assert.equal(v.where, 'unknown');
    assert.equal(v.inline?.interpreter, 'node');
  });

  it('判据是「拼不出字面量」，不是「认得出这段代码」', () => {
    /*
     * The escape above is NOT decoded — nothing here reads JavaScript. The verdict is the same
     * for a program that is perfectly innocent, because the point is what the TEXT proves, not
     * what this code could work out by running the program.
     */
    const innocent = verdict('node -e "console.log(1+1)"');
    assert.equal(innocent.where, 'unknown');
    assert.equal(innocent.readOnly, false);
  });

  it('每一种内联程序形态都判为不可知', () => {
    // portability-check:allow —— 同样是对照夹具：这些命令整条就是被测的输入文本。
    for (const c of [
      'python -c "import os; print(os.listdir(\'C:/\'))"',
      'python3 -c "print(1)"',
      'sh -c "cat /etc/passwd"',
      'bash -c "cat /etc/passwd"',
      'cmd /c "dir"',
      'pwsh -Command "Get-ChildItem C:\\Windows"',
      'powershell -EncodedCommand ZgBvAG8A',
      'perl -e "print 1"',
      'ruby -e "puts 1"',
      'deno eval "console.log(1)"',
      'node --eval "console.log(1)"',
    ]) {
      const v = verdict(c);
      assert.equal(v.readOnly, false, `${c} 被判成只读`);
      assert.equal(v.where, 'unknown', `${c} 的位置被判成可知：${v.where}`);
    }
  });

  it('变量与延迟展开同样不可知（路径要等 shell 展开才知道）', () => {
    for (const c of [
      'type %USERPROFILE%\\.ssh\\id_rsa',
      'echo %CD%',
      'cat $HOME/.ssh/id_rsa',
      'cat ${HOME}/x',
      'type ${env:USERPROFILE}\\x',
      'cat $(mktemp)',
      'cat `mktemp`',
      // 默认方言（posix）下的家目录展开 —— 和 $VAR 同属"文本里写着、位置要等展开"。
      'cat ~/.ssh/id_rsa',
      'cd ~ && echo x > y.txt',
    ]) {
      const v = verdict(c);
      assert.equal(v.where, 'unknown', `${c} 位置被判成 ${v.where}`);
      assert.equal(v.readOnly, false, `${c} 被判成只读`);
    }
  });

  it('~ 只在会展开它的方言里算不可知；cmd 方言上不算', () => {
    // 上游 `detectShellDialectMismatch` 已经把 `~/x` 当作 POSIX-only 构造，这里的分档和它一致：
    // sh / PowerShell 会展开 ~，cmd 方言不会 —— 在 cmd 上把 `~\notes.txt` 判成 unknown 就是误报。
    for (const c of ['cat ~/.ssh/id_rsa', 'cd ~ && echo x > y.txt', 'cat ~other/x', 'ls "~/notes"']) {
      assert.equal(classifyCommand(c, ROOT, 'posix').where, 'unknown', `${c} 在 posix 下被判成 ${classifyCommand(c, ROOT, 'posix').where}`);
      assert.equal(classifyCommand(c, ROOT, 'powershell').where, 'unknown', `${c} 在 powershell 下被判成 ${classifyCommand(c, ROOT, 'powershell').where}`);
    }
    assert.notEqual(classifyCommand('dir ~\\notes.txt', ROOT, 'cmd').where, 'unknown', 'cmd 里 ~ 只是普通文件名字符');
  });

  it('只认词首的 ~：出现在词中间的是普通文件名', () => {
    assert.equal(classifyCommand('cat a~b.txt', ROOT, 'posix').where, 'inside');
    assert.equal(classifyCommand('cat notes~', ROOT, 'posix').where, 'inside');
  });

  it('回归：V14 原文在 POSIX 下不再被判成 inside', () => {
    // 曾经的失败方式不是"没认出 ~"，而是认成了**相反**的答案：`cdEscapeInSegment` 把 `~` 交给
    // `staysInWorkspace`，后者 `resolve(root, '~')` 把它当成一个字面相对目录，于是 `cd ~` 被
    // 证明成"没出去"。修的是这一条，所以断言钉在 inside→unknown 这个方向上。
    assert.equal(classifyCommand('cd ~ && echo x > y.txt', ROOT, 'posix').where, 'unknown');
    assert.equal(classifyCommand('cd ~', ROOT, 'posix').where, 'unknown');
  });

  it('引号未闭合时两个答案都不可给', () => {
    const v = verdict('cat "unterminated');
    assert.equal(v.where, 'unknown');
    assert.equal(v.readOnly, false);
  });
});

describe('工作区边界：能解析的字面量给确切答案', () => {
  it('工作区外 → outside', () => {
    assert.equal(verdict(`cat ${ABS_OUTSIDE}`).where, 'outside');
    assert.equal(verdict('cat ../../README.txt').where, 'outside');
    assert.equal(verdict(`cd ${ABS_OUTSIDE.replace(/[^\\/]+$/, '')} && ls`).where, 'outside');
  });

  it('工作区内 → inside', () => {
    assert.equal(verdict(`cat ${ABS_INSIDE}`).where, 'inside');
    assert.equal(verdict('cat ./notes.md').where, 'inside');
    assert.equal(verdict('ls -la src').where, 'inside');
  });

  it('会被拒绝的越界命令仍然是 outside，而不是 unknown', () => {
    // Both answers are true of this one; `outside` is the more specific, so it wins — the
    // refusal message names a path instead of saying "something was hidden".
    const v = verdict('node -e "x" > ../../out.txt');
    assert.equal(v.where, 'outside');
    assert.match(v.reason, /工作区外/);
  });

  it('边界检查对 2a 那条命令本身返回 null —— 缺口是真的，补的是分类不是正则', () => {
    const escape = 'node -e "require(\'fs\').writeFileSync('
      + 'String.fromCharCode(67,58,92,111,117,116,46,116,120,116),\'1\')"';
    assert.equal(workspaceEscapeReason(escape, ROOT), null, '如果这条不再返回 null，本文件的结论要重读');
    assert.equal(classifyCommand(escape, ROOT).where, 'unknown');
  });
});

/**
 * 四档策略的端到端行为。
 *
 * 上面测的是分类器"能证明什么"；这一组测的是**拿到这些证明之后怎么处置** —— 也就是用户在设置页上
 * 那两个控件真正决定的事。分开写的理由：分类和处置是两层，混在一起测会让"分类对了但处置错了"这种
 * 失败看起来像分类的问题（第二轮实测里 V12–V17 有一半是这个形状）。
 *
 * 每一条都对着用户的原话，而不是我推测的合理行为：
 *   未勾选 → 除阅读类外一律要审批
 *   勾选+所有 → 无论在哪里跑什么都不需要审查
 *   勾选+只读 → 工作区内直接放行，工作区外非阅读类要审查
 *   勾选+拒绝 → 工作区内放行，工作区外非阅读类直接拒
 */
describe('四档权限策略：分类结果怎么处置', () => {
  const policy = (p: 'all' | 'readonly' | 'deny', allow = true) => ({ allow, policy: p });

  async function withRoot(fn: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'she-boundary-'));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** 问一次"这条命令要不要人工批准"。 */
  async function classify(dir: string, cmd: string, pol: ReturnType<typeof policy>) {
    const shell = new SandboxShell(dir, { outsideWorkspace: pol });
    const tools = createTools(shell, dir, { outsideWorkspace: pol });
    try {
      return await tools.execute('shell', { command: cmd });
    } finally {
      await shell.dispose();
    }
  }

  const OUT_WRITE = process.platform === 'win32'
    ? 'echo x > C:\\__she_no_such_dir__\\x.txt'
    : 'echo x > /__she_no_such_dir__/x.txt';
  const OUT_READ = process.platform === 'win32' ? 'type C:\\Windows\\win.ini' : 'cat /etc/hostname';

  it('未勾选：只读直接跑，非只读要批准', async () => {
    await withRoot(async (dir) => {
      const ro = await classify(dir, 'ls', policy('readonly', false));
      assert.ok(!ro.includes('needs_confirm'), `只读不该被问: ${ro}`);

      const write = await classify(dir, 'mkdir sub', policy('readonly', false));
      assert.match(write, /needs_confirm/, `工作区内的写也该问（未勾选=全覆盖）: ${write}`);
    });
  });

  it('勾选+所有：连工作区外的写都不用问', async () => {
    await withRoot(async (dir) => {
      const out = await classify(dir, OUT_WRITE, policy('all'));
      // 指向不存在的目录，所以这条要么被放行后自己失败，要么根本不该被问 —— 两种都不是 needs_confirm。
      assert.ok(!out.includes('needs_confirm'), `「所有」档下不该问: ${out}`);
    });
  });

  it('勾选+只读：工作区内放行，工作区外非只读要批准', async () => {
    await withRoot(async (dir) => {
      const inside = await classify(dir, 'mkdir sub', policy('readonly'));
      assert.ok(!inside.includes('needs_confirm'), `工作区内的写在只读档应直接放行: ${inside}`);

      const outside = await classify(dir, OUT_WRITE, policy('readonly'));
      assert.match(outside, /needs_confirm/, `工作区外的写要问: ${outside}`);
      // 确认卡要说清"为什么问" —— 四档下这是用户判断该不该点的唯一依据。
      assert.match(JSON.parse(outside).reason, /工作区外|位置无法判定/);
    });
  });

  it('勾选+拒绝：工作区外非只读直接拒，不提供"批准后放行"', async () => {
    await withRoot(async (dir) => {
      const outside = await classify(dir, OUT_WRITE, policy('deny'));
      assert.match(outside, /^DENIED:/, `拒绝档应直接拒: ${outside}`);
      assert.ok(!outside.includes('needs_confirm'), `拒绝档不该给票: ${outside}`);
    });
  });

  it('阅读类不看位置：越界只读在四档里都放行', async () => {
    await withRoot(async (dir) => {
      for (const p of ['all', 'readonly', 'deny'] as const) {
        const out = await classify(dir, OUT_READ, policy(p));
        assert.ok(!out.includes('needs_confirm') && !out.startsWith('DENIED:'), `${p} 档拦了越界只读: ${out}`);
      }
      const unchecked = await classify(dir, OUT_READ, policy('readonly', false));
      assert.ok(!unchecked.includes('needs_confirm'), `未勾选时阅读类也该放行: ${unchecked}`);
    });
  });

  it('第二轮实测 V12–V15：路径被藏起来时按危险那侧走', async () => {
    await withRoot(async (dir) => {
      const hidden: Array<[string, string]> = [
        ['环境变量（V12）', process.platform === 'win32' ? 'type %TEMP%\\x.txt' : 'cat $TMPDIR/x.txt'],
        ['for /f 从文件读路径（V13）', 'for /f "delims=" %i in (p.txt) do @type "%i"'],
        ['cd 换目录后用相对路径（V14）', process.platform === 'win32' ? 'cd /d %USERPROFILE% && echo x > y.txt' : 'cd ~ && echo x > y.txt'],
      ];
      for (const [label, cmd] of hidden) {
        const out = await classify(dir, cmd, policy('readonly'));
        assert.match(out, /needs_confirm/, `${label} 没有被拦: ${out}`);
      }
    });
  });
});
