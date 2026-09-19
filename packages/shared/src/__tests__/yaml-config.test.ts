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
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryLoadYaml, unknownTopLevelKeys, loadConfig } from '../config.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-yaml-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

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
