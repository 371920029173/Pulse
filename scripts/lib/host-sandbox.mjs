/**
 * 检查脚本要的那个沙箱档位：`off`，钉死，不管产品默认是什么。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么要有这个文件
 *
 * 层 4.2 的真隔离默认档位从 `off` 改成了 `auto`（`packages/shared/src/config.ts`）—— 一个验证过
 * 的边界却对所有人默认关着，等于这个能力不存在。但这次改动有一个连带后果，**门禁自己先撞上了**：
 *
 *   `check:toolresult` 有一条用例是「`cmd /c echo hi` 成功 → 分类为 none」。`auto` 生效后这条
 *   命令不再由 `cmd.exe` 解析，而是进 WSL 命名空间由 bash 解析 —— `cmd: command not found`，
 *   退出码 127，于是分类成了 `nonzero_exit`。它红得对：**这条断言量的东西跟它的名字不是一回事了。**
 *
 * 这就是「一台机器的能力决定了门禁结论」的那一类问题，和 `lib/hermetic.mjs` 记的是同一件事的
 * 两个面：那边是「跑门禁的那个环境不该决定结论」，这边是「跑门禁的那台机器不该决定结论」。
 * 一个只在自己机器上变绿（或变红）的门禁不是门禁。
 *
 * 边界本身有它自己的门禁：`check:sandbox-isolation`（真跑三种档位、比对隔离前后同一个文件能不能
 * 读）。所以**别的检查脚本一律不许隐式地测边界** —— 需要沙箱就钉 `off`，想测边界就写清楚档位。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 怎么用
 *
 *     const shell = new SandboxShell(dir, pinHostSandbox(cfg.sandbox));
 *     new SandboxShell(ws, pinHostSandbox({ ...cfg.sandbox, allowAllCommands: true }));
 *
 * 钉在**喂给沙箱的那个对象**上，不是钉在 `cfg` 上：`cfg.sandbox` 同一个文件里还会被拿去构造
 * `Agent`，而 `Agent` 只读 `allowAllCommands`（`agent.ts:1228`），pin 不 pin 都不影响它。
 * 另外 `pinHostSandbox` 永远放在最后展开，这样 `{ ...cfg.sandbox, ...sandbox }` 里后者带来的
 * `isolation` 也盖不掉这个钉子。
 *
 * 注意：`new SandboxShell(x)` 这种不传配置的写法**不算违规**，也不需要这个 pin ——
 * `packages/sandbox/src/shell.ts` 构造函数对缺省配置就取 `off`，理由写在那里（单元测试要密闭）。
 * 只有「把 `loadConfig` 出来的沙箱配置喂进去」这一种写法会随机器变。
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/lib/host-sandbox.mjs      # 自测（含「仓库里没有未钉档位的沙箱」那条守卫）
 */
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = fileURLToPath(import.meta.url);

/** 沙箱档位由 `check:sandbox-isolation` 专测；别处一律 `off`。 */
export const HOST_ISOLATION = 'off';

/**
 * 一份钉住了档位的沙箱配置。
 *
 * 最后一个位置展开，所以调用方 `{ ...cfg.sandbox, ...sandbox }` 里传进来的档位也改不掉它 ——
 * 这个顺序不是风格问题：`scripts/budget-check.mjs` 就是那个形状，pin 放前面会被 `...sandbox` 盖掉。
 */
export function pinHostSandbox(sandbox = {}) {
  return { ...sandbox, isolation: HOST_ISOLATION };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 守卫：检查脚本里不许再有「把产品配置直接喂给沙箱」的调用
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 扫出「参数里提到了 sandbox、但没有钉档位」的 `new SandboxShell(...)`。
 *
 * 判据只看参数那一段文本，两个条件同时成立才算违规：
 *   - 参数里出现 `sandbox`（`cfg.sandbox` / `c.sandbox` / `{ ...cfg.sandbox, … }` 三种写法都命中）
 *   - 参数里既没有 `pinHostSandbox(` 也没有 `isolation:`
 *
 * 于是 `new SandboxShell(tempDir)` 与 `new SandboxShell(dir, { allowAllCommands: true })` 都不算 ——
 * 它们的档位由构造函数缺省成 `off`，跟机器无关。守卫要抓的只是「随机器变」的那一种。
 *
 * 取参数用括号配对而不是正则扫到行尾：`pinHostSandbox(cfg.sandbox)` 和
 * `{ ...cfg.sandbox, allowAllCommands: true }` 里面都有括号，扫到行尾会连下一行一起吞掉。
 * 递归扫 `evals/`（那里的 `run.mjs` 用同一份配置建沙箱）。
 *
 * 扫的时候跳过本文件：它的自测夹具就是**写在字符串里的**反例（和注释里的一样，不是真调用）。
 * `hermetic.mjs` 靠「只扫 `scripts/*.mjs`、不递归」避开同一件事；这里要扫 `lib/`，所以显式跳过。
 */
export function unpinnedSandboxSpawns(dirs = [join(ROOT, 'scripts'), join(ROOT, 'evals')]) {
  const found = [];
  for (const file of walk(dirs)) {
    if (resolve(file) === resolve(SELF)) continue;
    const text = readFileSync(file, 'utf8');
    for (const [start, args] of sandboxShellCalls(text)) {
      if (!/sandbox/i.test(args)) continue;
      if (/pinHostSandbox\s*\(/.test(args) || /isolation\s*:/.test(args)) continue;
      const rel = relative(ROOT, file);
      found.push({ file: (rel.startsWith('..') ? file : rel).replace(/\\/g, '/'), line: lineOf(text, start) });
    }
  }
  return found;
}

/** `new SandboxShell(` 之后那一段括号里的文本，按括号配对取。注释先抹掉。 */
function* sandboxShellCalls(text) {
  const code = stripComments(text);
  const re = /new\s+SandboxShell\s*\(/g;
  for (const m of code.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      const ch = code[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          yield [m.index, code.slice(open + 1, i)];
          break;
        }
      }
    }
  }
}

/**
 * 把注释换成等长空格 —— 等长是为了行号不漂。
 *
 * 为什么不用 `/\/\/.*$/` 了事：`'http://x'` 这种字符串里的 `//` 会被它当成注释开头，从那里切到行尾，
 * 后面真正要抓的调用就一起没了 —— 那是**漏报**，比误报更糟。所以要认引号状态。
 * （注释里举例说明"别这么写"是常见写法，`lib/hermetic.mjs` 就为同一件事加过同一条豁免。）
 */
function stripComments(text) {
  const out = [...text];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i++;
      while (i < text.length && text[i] !== ch) i += text[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) out[i++] = ' ';
      for (let k = 0; k < 2 && i < text.length; k++) out[i++] = ' ';
      continue;
    }
    i++;
  }
  return out.join('');
}

function* walk(dirs) {
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === 'node_modules' || name === 'dist') continue;
        yield* walk([p]);
      } else if (name.endsWith('.mjs')) {
        yield p;
      }
    }
  }
}

function lineOf(text, at) {
  return text.slice(0, at).split('\n').length;
}

/* ─── 自测 ─── */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let failures = 0;
  const check = (label, cond, detail) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) { failures++; if (detail !== undefined) console.log(`        ${String(detail).slice(0, 400)}`); }
  };

  console.log('\n1. 钉什么');
  const pinned = pinHostSandbox({ allowAllCommands: true, isolation: 'auto', wslDistro: 'Ubuntu' });
  check('档位被钉成 off', pinned.isolation === 'off', JSON.stringify(pinned));
  check('别的字段原样带过去（这个函数只管一个轴）',
    pinned.allowAllCommands === true && pinned.wslDistro === 'Ubuntu', JSON.stringify(pinned));
  check('【关键】调用方后展开的档位也盖不掉它（budget-check 那个形状）',
    pinHostSandbox({ ...{ allowAllCommands: true }, ...{ isolation: 'auto' } }).isolation === 'off');
  check('不传参也不炸', pinHostSandbox().isolation === 'off');

  console.log('\n2. 守卫：违规要判出来，别的一个都不许误报');
  const fixtures = {
    // 违规：产品配置直接喂进沙箱，三种写法
    'a.mjs': 'const shell = new SandboxShell(dir, cfg.sandbox);',
    'b.mjs': 'const shell = new SandboxShell(ws, { ...cfg.sandbox, allowAllCommands: true });',
    'c.mjs': 'const t = createTools(new SandboxShell(root, c.sandbox), root, {});',
    'd.mjs': 'const shell = new SandboxShell(\n  dir,\n  cfg.sandbox,\n);',
    // 合规：钉了档位（两种钉法），或压根没碰产品配置
    'e.mjs': 'const shell = new SandboxShell(dir, pinHostSandbox(cfg.sandbox));',
    'f.mjs': 'const shell = new SandboxShell(dir, { ...cfg.sandbox, isolation: "off" });',
    'g.mjs': 'const shell = new SandboxShell(workspace, { allowAllCommands: true });',
    'h.mjs': 'const shell = new SandboxShell(tempDir);',
    'i.mjs': 'const shell = new SandboxShell(ROOT, { ...permissive, isolation: "wsl" });',
    // 合规且必须不误报：注释里写的反例
    'j.mjs': '// 别这么写：new SandboxShell(dir, cfg.sandbox)\nconst ok = 1;\n',
    // 违规，且必须不被字符串里的 `//` 吃掉（漏报比误报更糟）
    'k.mjs': 'const u = "http://stub.invalid";\nconst shell = new SandboxShell(dir, cfg.sandbox);\n',
    'l.mjs': '/* new SandboxShell(dir, cfg.sandbox) 是反例 */\nconst shell = new SandboxShell(dir, cfg.sandbox);\n',
  };
  const probeDir = mkdtempForProbe();
  let probe = [];
  try {
    for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(probeDir, name), body, 'utf8');
    probe = unpinnedSandboxSpawns([probeDir]).map((h) => h.file.split(/[\\/]/).pop()).sort();
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  for (const f of ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs']) {
    check(`守卫：${f} 判出来（${fixtures[f].split('\n')[0].slice(0, 46)}…）`, probe.includes(f), probe.join(','));
  }
  check('【关键】字符串里的 `//` 不吃掉后面的违规（漏报比误报更糟）', probe.includes('k.mjs'), probe.join(','));
  check('块注释里的反例算注释，注释外的照抓', probe.includes('l.mjs'), probe.join(','));
  check('【关键】不误报已钉档位的写法（pinHostSandbox / isolation: 两种都算）',
    !probe.includes('e.mjs') && !probe.includes('f.mjs'), probe.join(','));
  check('不误报没碰产品配置的沙箱（档位由构造函数缺省成 off，与机器无关）',
    !probe.includes('g.mjs') && !probe.includes('h.mjs') && !probe.includes('i.mjs'), probe.join(','));
  check('【关键】不误报注释里写的反例（假红会让人开始忽略这条守卫）',
    !probe.includes('j.mjs'), probe.join(','));
  check('多行写法报出的行号是 `new` 那一行，不是参数那一行',
    (() => {
      const one = mkdtempForProbe();
      try {
        writeFileSync(join(one, 'm.mjs'), 'const a = 1;\n\nconst shell = new SandboxShell(\n  dir,\n  cfg.sandbox,\n);\n', 'utf8');
        return unpinnedSandboxSpawns([one])[0]?.line === 3;
      } finally { rmSync(one, { recursive: true, force: true }); }
    })());

  console.log('\n3. 仓库里现在没有违规');
  const live = unpinnedSandboxSpawns();
  check('【关键】检查脚本里的沙箱都钉了档位（有的话它的结论就随机器变）',
    live.length === 0, live.map((h) => `${h.file}:${h.line}`).join(', '));

  console.log('');
  if (failures) {
    console.log(`${failures} 项失败`);
    process.exit(1);
  }
  console.log('沙箱档位自测通过');
}

function mkdtempForProbe() {
  const base = process.env.TEMP || process.env.TMPDIR || process.env.TMP || '/tmp';
  const dir = join(base, `she-host-sandbox-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
