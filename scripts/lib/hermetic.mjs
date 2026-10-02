/**
 * 门禁子进程的环境：只带「跑这台机器需要的」，不带「这个安装的配置」。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么要这个
 *
 * 一个检查脚本要跑一个 server / 一个测试套件时，习惯写法是
 *
 *     env: { ...process.env, SHE_PORT: ..., SHE_ENV_FILE: ... }
 *
 * 想法是「我把该定的都定了」。但 `...process.env` 把**跑门禁的那个环境**也带进去了，而
 * `loadConfig` 的优先级是 **真实环境变量 > 配置文件**（`.env` 只补环境里没有的键）。于是检查
 * 自己写的那个 `.env` 会被外层环境盖掉 —— 恰恰是它想避免的事。
 *
 * 这不是理论问题。SHE 自己的沙箱（`packages/sandbox/src/shell.ts`）把 server 的整个
 * `process.env` 交给每条命令，而 server 启动时已经把 `.env` 读进了自己的 `process.env`。
 * 所以在 SHE 里跑 `pnpm check:offline`，每条命令的环境里都有 `OPENAI_MODEL=deepseek-flash`、
 * `SHE_ALLOW_ALL_COMMANDS=1`、`OPENAI_API_KEY=…` —— 实测后果：
 *
 *   - `check:suites`：`packages/shared` 66 项 / 63 过 / 3 失，报「期望 from-she-config，实得
 *     deepseek-flash」。看着像配置文件没被读到，其实是配置文件被环境盖住了。
 *   - `check:mcp`：桩模型一次请求都没收到（`offered=0`），因为 agent 拿着环境里的
 *     `OPENAI_BASE_URL=https://api.deepseek.com` 去连真服务了，没连检查自己起的桩。
 *   - 同一份门禁在干净的终端里全绿。同一个人、同一份代码，结论取决于他从哪儿敲的命令。
 *
 * 一个只能在自己机器上变绿的门禁不是门禁。所以检查脚本不许再整体继承外层环境：用
 * `hermeticEnv({...自己钉住的})`，外层环境里那四个前缀的键全部丢掉，检查自己钉住的照常生效，
 * 机器本身需要的东西（`PATH`、`SystemRoot`、`TEMP`、`USERPROFILE` …）一个不少。
 *
 * 丢哪些键不是手写清单：`loadConfig` 读的键全部落在 `SHE_` / `OPENAI_` / `ANTHROPIC_` / `AGI_`
 * 四个前缀下（`configEnvNames()` 直接从 `config.ts` 源码里数，自测会核对这个前提），所以按前缀
 * 丢，`loadConfig` 以后多读一个键也不用改这里。
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/lib/hermetic.mjs      # 自测（含「仓库里没有违规」那条守卫）
 */
import { readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SCRIPTS = join(ROOT, 'scripts');
const CONFIG_SRC = join(ROOT, 'packages', 'shared', 'src', 'config.ts');

/** `loadConfig` 会读的键族。丢环境按这个前缀丢。 */
export const CONFIG_ENV_FAMILY = /^(SHE|OPENAI|ANTHROPIC|AGI)_/;

/**
 * 从 `config.ts` 源码里数出 `loadConfig` 读到的每一个环境变量名。
 *
 * 用源码而不是手写清单：写清单就会过期，而过期的清单会让「丢哪些键」这件事重新变成
 * 「谁记得改这里」。
 */
export function configEnvNames(source = readFileSync(CONFIG_SRC, 'utf8')) {
  const names = new Set();
  for (const m of source.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g)) names.add(m[1]);
  for (const m of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]);
  return [...names].sort();
}

/**
 * 一个检查脚本该给子进程的环境：外层环境里的配置键族丢掉，`pins` 说了算。
 *
 * `base` 只是给自测留的入口 —— 生产调用一律用默认的 `process.env`。
 */
export function hermeticEnv(pins = {}, base = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(base)) {
    if (!CONFIG_ENV_FAMILY.test(key)) out[key] = value;
  }
  return { ...out, ...pins };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 守卫：检查脚本里不许再有「整体继承外层环境」的 env
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 允许整体继承外层环境的脚本。
 *
 * 只有启动「真应用」的地方可以：它要的就是用户那份环境（`pnpm she` 起 server 时若把用户的
 * 配置丢掉，应用就跑不起来了）。门禁脚本一个都不在此列。
 */
export const ALLOWED_INHERIT = new Set([
  'she.mjs',
]);

/**
 * 找出 `env:` / `xxxEnv =` 对象里还整体继承 `...process.env` 的位置。
 *
 * 只看「对象的键叫 env」那一种写法：`const saved = { ...process.env }` 是快照，不是子进程环境，
 * 不该被当成违规。所以先按花括号配对找到 `...process.env` 所在对象的那个 `{`，再看它前面写的是
 * 不是 `env` —— 比正则扫到行尾可靠，也不会因为对象里有嵌套而漏掉。
 */
export function nonHermeticSpawns(dir = SCRIPTS) {
  const found = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.mjs') || ALLOWED_INHERIT.has(file)) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    for (const m of text.matchAll(/\.\.\.process\.env\b/g)) {
      const at = m.index;
      /*
       * 行注释里提到的反例不算违规。
       *
       * 这条不是"理论上的误报"：本文件的守卫自测把夹具放在 `scripts/lib/` 下（守卫只扫
       * `scripts/*.mjs`，不递归），但写检查的人如果想在注释里说明"别这么写"，就会直接命中。
       * 那种红是假红，而假红会让人开始忽略这条守卫 —— 代价比漏报还大。
       */
      const lineStart = text.lastIndexOf('\n', at) + 1;
      if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, at))) continue;
      let depth = 0;
      let open = -1;
      for (let i = at; i >= 0; i--) {
        const ch = text[i];
        if (ch === '}') depth++;
        else if (ch === '{') {
          if (depth === 0) { open = i; break; }
          depth--;
        }
      }
      if (open < 0) continue;
      const before = text.slice(Math.max(0, open - 60), open);
      if (!/env\s*[:=]\s*$/i.test(before)) continue;
      found.push({ file, line: text.slice(0, at).split('\n').length });
    }
  }
  return found;
}

/* ─── 自测 ─── */
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  let failures = 0;
  const check = (label, cond, detail) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) { failures++; if (detail !== undefined) console.log(`        ${String(detail).slice(0, 400)}`); }
  };

  console.log('\n1. 丢什么、留什么');
  /*
   * 夹具里的系统变量用占位值，不用 `/usr/bin` 这类真实路径。
   *
   * 这条自测要断言的是「这些键被原样带过去」，不是「它们长得像什么」。写成真实路径会撞上
   * `check:portability` 的「未分支的 POSIX 绝对路径」—— 而且是真的在 WSL 里撞上了（它跑在
   * Linux 一侧，报了三行）。规则没错，是夹具多余地像了真的东西。
   */
  const polluted = {
    PATH: 'KEEP-PATH',
    SystemRoot: 'KEEP-SYSTEMROOT',
    TEMP: 'KEEP-TEMP',
    OPENAI_MODEL: 'deepseek-flash',
    OPENAI_API_KEY: 'sk-real',
    SHE_ALLOW_ALL_COMMANDS: '1',
    SHE_AUTOMATION_MODE: 'true',
    ANTHROPIC_MODEL: 'claude-real',
    AGI_USE_API_KEY: 'sk-agi',
  };
  const env = hermeticEnv({ SHE_PORT: '4577' }, polluted);
  check('外层环境里的模型名不再传下去（就是它盖掉了检查自己的 .env）', env.OPENAI_MODEL === undefined, env.OPENAI_MODEL);
  check('API key 不再传下去', env.OPENAI_API_KEY === undefined, env.OPENAI_API_KEY);
  check('姿态类开关不再传下去（否则检查里的沙箱姿态由外层决定）',
    env.SHE_ALLOW_ALL_COMMANDS === undefined && env.SHE_AUTOMATION_MODE === undefined, JSON.stringify(env));
  check('别的 provider 的环境同样丢掉', env.ANTHROPIC_MODEL === undefined && env.AGI_USE_API_KEY === undefined);
  check('【关键】检查自己钉的仍然生效', env.SHE_PORT === '4577', env.SHE_PORT);
  check('机器本身需要的照旧（PATH / SystemRoot / TEMP）',
    env.PATH === 'KEEP-PATH' && env.SystemRoot === 'KEEP-SYSTEMROOT' && env.TEMP === 'KEEP-TEMP',
    JSON.stringify(env));
  check('没有 pins 时也不炸', hermeticEnv(undefined, polluted).PATH === 'KEEP-PATH');
  check('空 base 得到空对象而不是 undefined', JSON.stringify(hermeticEnv({}, {})) === '{}');

  console.log('\n2. 「四个前缀装得下 loadConfig 读的一切」—— 承重前提');
  const names = configEnvNames();
  const outside = names.filter((n) => !CONFIG_ENV_FAMILY.test(n));
  check(`认出 config.ts 里的键（${names.length} 个）`, names.length >= 40, names.length);
  check('【关键】没有跑在四个前缀外的键（有的话丢环境会漏掉它）', outside.length === 0, outside.join(', '));
  check('正则失效会被这条抓住（喂一段没有键的源码 → 认出 0 个）', configEnvNames('const a = 1;').length === 0);

  console.log('\n3. 守卫：违规要判出来，别的一个都不许误报');
  const fake = {
    'a.mjs': 'spawn(x, { env: { ...process.env, SHE_PORT: "1" } });',
    'b.mjs': 'const env = { ...process.env, FORCE_COLOR: "0" };',
    'c.mjs': 'const offlineEnv = {\n  ...process.env,\n  OPENAI_API_KEY: "",\n};',
    'd.mjs': 'const saved = { ...process.env };',
    'e.mjs': 'spawn(x, { env: hermeticEnv({ SHE_PORT: "1" }) });',
    'f.mjs': 'const env = { ...process.env, X: { nested: 1 } };',
    'g.mjs': '// 别这么写：env: { ...process.env, SHE_PORT: "1" }\nconst ok = 1;',
    'h.mjs': '/* env: { ...process.env } 是反例，写在注释里不该被算成违规 */\nconst ok = 1;',
  };
  const probeDir = mkdtempForProbe();
  let probe = [];
  try {
    for (const [name, body] of Object.entries(fake)) writeFileSync(join(probeDir, name), body, 'utf8');
    probe = nonHermeticSpawns(probeDir).map((h) => h.file).sort();
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  check('守卫：`env: { ...process.env, … }` 判出来（host-guard 那处）', probe.includes('a.mjs'), probe.join(','));
  check('守卫：`const env = { ...process.env, … }` 判出来（docs-check 那处）', probe.includes('b.mjs'), probe.join(','));
  check('守卫：多行写法判出来（mcp-check 那处）', probe.includes('c.mjs'), probe.join(','));
  check('守卫：对象里有嵌套也判出来', probe.includes('f.mjs'), probe.join(','));
  check('【关键】不误报快照（`const saved = {...process.env}` 不是子进程环境）', !probe.includes('d.mjs'), probe.join(','));
  check('不误报 hermeticEnv 自己', !probe.includes('e.mjs'), probe.join(','));
  check('【关键】不误报注释里写的反例（假红会让人开始忽略这条守卫）',
    !probe.includes('g.mjs') && !probe.includes('h.mjs'), probe.join(','));
  check('【关键】仓库里现在没有违规（有的话检查脚本又会被外层环境左右）',
    nonHermeticSpawns().length === 0, nonHermeticSpawns().map((h) => `${h.file}:${h.line}`).join(', '));

  console.log('');
  if (failures) {
    console.log(`${failures} 项失败`);
    process.exit(1);
  }
  console.log('环境密闭性自测通过');
}

function mkdtempForProbe() {
  const base = process.env.TEMP || process.env.TMPDIR || process.env.TMP || '/tmp';
  const dir = join(base, `she-hermetic-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
