/**
 * Config file parsing.
 *
 * The parser this replaced was hand-rolled and did `if (!match) continue` on any line
 * it did not understand. Two consequences, both silent:
 *
 *   - it could not express a LIST, so a `models:` registry was written by a user,
 *     ignored without a word, and the default used instead;
 *   - a structural typo produced no feedback at all, making "my setting does nothing"
 *     the hardest class of bug to find.
 *
 * These tests pin the replacement's contract: parse the full YAML subset, and THROW
 * on a file that cannot be understood rather than quietly using defaults.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryLoadYaml, unknownTopLevelKeys, loadConfig } from '../config.js';

let dir: string;

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么这个文件要先把环境洗干净
 *
 * 下面几条断言的是「配置文件里的值被用上了」。但 `loadConfig` 的优先级是
 * **真实环境变量 > 配置文件**（产品行为：`.env` 只是补上环境里没有的键，而操作系统里显式设过的
 * 永远赢），而它读的 43 个键**全部**落在 `SHE_` / `OPENAI_` / `ANTHROPIC_` / `AGI_` 四个前缀下
 * （`都在这四个前缀下` 那条用例会重新从源码里数一遍，防止这个前提失效）。
 *
 * 于是只要跑这个文件的进程里恰好带着 `OPENAI_MODEL`，断言期望的配置文件值就会被环境里的模型名
 * 盖掉：
 *
 *   期望 from-she-config / from-override，实得 deepseek-flash
 *   # tests 66 · # pass 63 · # fail 3
 *
 * 这不是假想：把本机 `.env` 里的 `OPENAI_MODEL=deepseek-flash` 放进环境再跑这个文件，得到的就是
 * 上面这组数字，与门禁里那次逐字相同。而**门禁真的会带着它**：SHE 自己的沙箱里，后端启动时
 * 已经把 `.env` 读进了自己的 `process.env`，它派生的每条命令都继承 —— 也就是说，用来验证这个
 * 仓库的环境，恰好是会把 `OPENAI_MODEL` 带进来的那个环境。测试不该因此变红：红的不是代码，
 * 是它读到了「谁在跑它」。
 *
 * 两个动作，各堵一条路：
 *   1. `SHE_ENV_FILE` 钉在临时目录里（一个不存在的文件）。`resolveEnvFile` 的兜底顺序是
 *      「项目根 → 当前工作目录」，所以只要测试进程的 cwd 恰好是某个带 `.env` 的目录（从仓库根
 *      直接跑、或在别人的项目里跑），它就会把**那个项目的** `.env` 加载进来。钉住之后，
 *      环境文件的来源与 cwd 无关。
 *   2. 环境里那四个前缀的键先拿走，跑完放回去。
 *
 * 产品行为不动：`loadConfig` 仍然让真实环境变量赢（那是 .env 语义的一部分），`resolveEnvFile`
 * 仍然有 cwd 兜底（它是「从子目录启动也能找到安装根 .env」那条用途，`resolveEnvFile` 那段用例
 * 把它钉住）。要改的是**测试对环境的依赖**，不是产品。
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** 能盖过配置文件的键族。与 `loadConfig` 实际读到的集合一致，由下面的用例机械核对。 */
const ENV_FAMILY = /^(SHE|OPENAI|ANTHROPIC|AGI)_/;

let savedEnv: Record<string, string> = {};

/** 把环境里能盖过配置文件的键拿走，记下来等着放回去。 */
function cleanEnv(): void {
  savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (ENV_FAMILY.test(key)) {
      savedEnv[key] = process.env[key] as string;
      delete process.env[key];
    }
  }
}

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) if (ENV_FAMILY.test(key)) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  savedEnv = {};
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'she-yaml-'));
  cleanEnv();
  // 一个不可能存在的环境文件：环境文件的来源从此与 cwd 无关。
  process.env.SHE_ENV_FILE = join(dir, '.env');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  restoreEnv();
});

describe('这个文件的环境卫生（它决定上面那些断言看不看得出真假）', () => {
  it('清洗真的在干活：污染一个键，洗一遍就没了', () => {
    process.env.OPENAI_MODEL = 'polluted';
    process.env.SHE_MODEL = 'polluted';
    assert.equal(process.env.OPENAI_MODEL, 'polluted');
    cleanEnv();
    assert.equal(process.env.OPENAI_MODEL, undefined, 'OPENAI_MODEL 没被清掉');
    assert.equal(process.env.SHE_MODEL, undefined, 'SHE_MODEL 没被清掉');
  });

  it('环境文件的来源与 cwd 无关（cwd 兜底不再能把别人的 .env 拉进来）', () => {
    /*
     * `resolveEnvFile` 的顺序是「项目根 → 当前工作目录」：临时目录里没有 `.env` 时，它会去
     * 测试进程的 cwd 找一个。从仓库根跑（cwd 就是那个带 `.env` 的目录）时，这个兜底就会把
     * 仓库自己的 `.env` 加载进 `loadConfig(临时目录)`。把 `SHE_ENV_FILE` 钉在临时目录里，
     * 这一条路就断了 —— 而且这正是 `SHE_ENV_FILE` 的文档用途（显式指定环境文件）。
     */
    assert.equal(process.env.SHE_ENV_FILE, join(dir, '.env'));
  });

  it('【关键】真实环境变量优先于配置文件 —— 这是产品行为，别为了测试把它改掉', () => {
    /*
     * 这条不测 bug，它测的是「修哪一边」。上一条把环境洗干净，是因为环境变量赢是**对的**：
     * `.env` 的语义就是「补上环境里没有的键」，显式设过的永远算数。所以门禁里那 3 条红，
     * 修的是测试对环境的依赖，不是这条优先级。哪天有人为了让测试变绿把它反过来，
     * 这条会红并给出理由。
     */
    write('she.config.yaml', 'llm:\n  model: from-she-config\n');
    process.env.OPENAI_MODEL = 'deepseek-flash';
    try {
      assert.equal(loadConfig(dir).llm.model, 'deepseek-flash',
        '环境变量必须赢：红了说明改错了边（该改的是测试的环境，不是这条优先级）');
    } finally {
      delete process.env.OPENAI_MODEL;
    }
  });

  it('都在这四个前缀下（loadConfig 读到的键没有一个跑在外面）', () => {
    /*
     * 清洗是按前缀做的，所以「前缀覆盖得住」是一个承重前提：`loadConfig` 哪天开始读一个别的
     * 前缀的键（比如 `MODEL`、`HOME`、`NODE_ENV`），清洗就会漏掉它，而这个文件会重新变成
     * 「在别人机器上红、在自己机器上绿」。断言直接从源码里数，避免手写清单过期。
     */
    const source = readFileSync(join(process.cwd(), 'src', 'config.ts'), 'utf8');
    const names = new Set<string>();
    for (const m of source.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1]!);
    for (const m of source.matchAll(/process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g)) names.add(m[1]!);
    const outside = [...names].filter((n) => !ENV_FAMILY.test(n)).sort();
    assert.ok(names.size >= 40, `只从 config.ts 里认出了 ${names.size} 个键，正则大概失效了`);
    assert.deepEqual(outside, [],
      `这些键不在清洗的前缀里，测试会被环境左右: ${outside.join(', ')}`);
  });
});

/** Write a config file and parse it. No BOM — PowerShell's Set-Content adds one. */
function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('tryLoadYaml', () => {
  it('文件不存在时返回 null', () => {
    assert.equal(tryLoadYaml(join(dir, 'nope.yaml')), null);
  });

  it('解析嵌套映射', () => {
    const p = write('a.yaml', [
      'llm:',
      '  provider: openai',
      '  model: gpt-4o',
      'server:',
      '  port: 4577',
    ].join('\n'));
    const c = tryLoadYaml(p);
    assert.equal(c?.llm && (c.llm as Record<string, unknown>).provider, 'openai');
    assert.equal((c?.llm as Record<string, unknown>).model, 'gpt-4o');
    assert.equal((c?.server as Record<string, unknown>).port, 4577);
  });

  it('【关键】能解析列表（旧的手写解析器完全做不到）', () => {
    /*
     * This is what the model registry needs. The previous parser's key regex was
     * `/^([\w.]+)\s*:\s*(.*)/`, which cannot match a line beginning with `- `, so
     * every list was dropped without a word.
     */
    const p = write('b.yaml', [
      'llm:',
      '  models:',
      '    - id: fast',
      '      model: cheap',
      '    - id: smart',
      '      model: pricey',
      '      baseUrl: https://x.example',
    ].join('\n'));
    const c = tryLoadYaml(p);
    const models = (c?.llm as Record<string, unknown>)?.models as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(models), '列表没有被解析出来');
    assert.equal(models.length, 2);
    assert.equal(models[0].id, 'fast');
    assert.equal(models[1].baseUrl, 'https://x.example');
  });

  it('解析数字、布尔、null 与引号字符串', () => {
    const p = write('c.yaml', [
      'a: 42',
      'b: 3.5',
      'c: true',
      'd: false',
      'e: null',
      'f: "quoted"',
      "g: 'single'",
      'h: plain text',
    ].join('\n'));
    const c = tryLoadYaml(p) as Record<string, unknown>;
    assert.equal(c.a, 42);
    assert.equal(c.b, 3.5);
    assert.equal(c.c, true);
    assert.equal(c.d, false);
    assert.equal(c.e, null);
    assert.equal(c.f, 'quoted');
    assert.equal(c.g, 'single');
    assert.equal(c.h, 'plain text');
  });

  it('忽略注释与空行', () => {
    const p = write('d.yaml', ['# 顶部注释', '', 'llm:', '  # 内部注释', '  model: m'].join('\n'));
    assert.equal((tryLoadYaml(p)?.llm as Record<string, unknown>).model, 'm');
  });

  it('【关键】格式错误时抛错，而不是静默用默认值', () => {
    /*
     * Failing loudly at startup is better than running with a config the user did not
     * intend — they wrote the file, so they want to know it is wrong.
     */
    const p = write('bad.yaml', 'llm:\n  model: "unterminated\n  provider: openai\n');
    assert.throws(() => tryLoadYaml(p), /无法解析/);
  });

  it('【关键】顶层是列表时报错（配置必须是映射）', () => {
    const p = write('list.yaml', '- one\n- two\n');
    assert.throws(() => tryLoadYaml(p), /映射/);
  });

  it('空文件返回 null 而不是抛错', () => {
    const p = write('empty.yaml', '');
    assert.equal(tryLoadYaml(p), null);
  });

  it('全是注释的文件返回 null', () => {
    const p = write('comments.yaml', '# nothing here\n# really\n');
    assert.equal(tryLoadYaml(p), null);
  });

  it('带连字符的键能解析（旧解析器的 \\w 也不支持）', () => {
    const p = write('dash.yaml', 'llm:\n  max-tokens: 100\n');
    assert.equal((tryLoadYaml(p)?.llm as Record<string, unknown>)['max-tokens'], 100);
  });
});

describe('unknownTopLevelKeys', () => {
  it('已知的键不报警', () => {
    assert.deepEqual(unknownTopLevelKeys({ llm: {}, kb: {}, server: {} }), []);
  });

  it('未知的键被列出（提示拼写错误）', () => {
    const unknown = unknownTopLevelKeys({ llm: {}, llmm: {}, kb: {} });
    assert.deepEqual(unknown, ['llmm']);
  });

  it('空对象不报警', () => {
    assert.deepEqual(unknownTopLevelKeys({}), []);
  });
});

describe('loadConfig 与配置文件', () => {
  it('读取配置文件里的注册表', () => {
    write('she.config.yaml', [
      'llm:',
      '  provider: openai',
      '  model: top',
      '  models:',
      '    - id: fast',
      '      model: cheap',
    ].join('\n'));
    const cfg = loadConfig(dir);
    assert.equal(cfg.llm.models?.length, 1);
    assert.equal(cfg.llm.models?.[0].id, 'fast');
  });

  it('配置文件不存在时用默认值', () => {
    const cfg = loadConfig(dir);
    assert.equal(cfg.llm.models, undefined);
    assert.equal(typeof cfg.llm.model, 'string');
  });

  it('配置文件损坏时抛出可定位的错误', () => {
    write('she.config.yaml', 'llm:\n  model: "broken\n');
    assert.throws(() => loadConfig(dir), (err: Error) => {
      // The message must name the file, or the user has to guess which config is at
      // fault in a project that accepts four filenames.
      assert.match(err.message, /she\.config\.yaml/);
      return true;
    });
  });

  it('优先使用 she.config.yaml，其次 config.yaml', () => {
    write('config.yaml', 'llm:\n  model: from-config\n');
    write('she.config.yaml', 'llm:\n  model: from-she-config\n');
    assert.equal(loadConfig(dir).llm.model, 'from-she-config');
  });

  it('示例配置本身可以解析（防止文档过期到跑不通）', () => {
    // The example ships to users; if it stops parsing, the first thing they try fails.
    const examplePath = join(process.cwd(), 'config.example.yaml');
    if (!existsSync(examplePath)) return;
    const parsed = tryLoadYaml(examplePath);
    assert.ok(parsed, 'config.example.yaml 解析失败');
    assert.deepEqual(unknownTopLevelKeys(parsed!), [], '示例里有未知的顶层键');
    assert.ok(parsed!.llm, '示例缺少 llm 段');
  });
});

describe('SHE_CONFIG_FILE', () => {
  const original = process.env.SHE_CONFIG_FILE;
  afterEach(() => {
    if (original === undefined) delete process.env.SHE_CONFIG_FILE;
    else process.env.SHE_CONFIG_FILE = original;
  });

  it('可以指定任意位置的配置文件', () => {
    /*
     * Without this the file had to sit in the install root — fine for one local
     * install, wrong for a container (read-only image, config on a volume) and for
     * anyone keeping several configurations side by side.
     */
    const elsewhere = mkdtempSync(join(tmpdir(), 'she-cfg-elsewhere-'));
    try {
      const p = join(elsewhere, 'custom.yaml');
      writeFileSync(p, 'llm:\n  model: from-override\n', 'utf8');
      process.env.SHE_CONFIG_FILE = p;
      assert.equal(loadConfig(dir).llm.model, 'from-override');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('优先于安装根目录里的文件', () => {
    write('she.config.yaml', 'llm:\n  model: from-root\n');
    const elsewhere = mkdtempSync(join(tmpdir(), 'she-cfg-priority-'));
    try {
      const p = join(elsewhere, 'custom.yaml');
      writeFileSync(p, 'llm:\n  model: from-override\n', 'utf8');
      process.env.SHE_CONFIG_FILE = p;
      assert.equal(loadConfig(dir).llm.model, 'from-override');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('【关键】指向不存在的文件时报错，而不是静默用默认值', () => {
    // Silently falling back would look exactly like the settings being ignored.
    process.env.SHE_CONFIG_FILE = join(dir, 'does-not-exist.yaml');
    assert.throws(() => loadConfig(dir), /不存在/);
  });
});

describe('未知配置键', () => {
  it('会发出警告（否则拼错等于设置被忽略）', () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    try {
      write('she.config.yaml', [
        'llm:',
        '  model: ok',
        'llmm:',
        '  model: typo',
      ].join('\n'));
      loadConfig(dir);
    } finally {
      console.warn = originalWarn;
    }
    const hit = warnings.find((w) => w.includes('llmm'));
    assert.ok(hit, `没有对未知键发出警告，实际警告: ${JSON.stringify(warnings)}`);
  });

  it('已知的键不会触发警告', () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
    try {
      write('she.config.yaml', 'llm:\n  model: ok\nkb:\n  activationBudget: 50\n');
      loadConfig(dir);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.filter((w) => w.includes('未识别')).length, 0, warnings.join(' | '));
  });
});
