/**
 * LSP integration check.
 *
 * Two things are worth guarding:
 *
 *  1. The client answers correctly. A language server produces plausible-looking
 *     output even when it is wrong — e.g. resolving an imported symbol to its
 *     IMPORT line instead of the declaration, which it does until the project
 *     finishes loading. Only asserting on real positions catches that.
 *
 *  2. The agent actually gets the tools. A tool that exists but is never
 *     registered is invisible to the model, and no amount of unit testing the
 *     client would notice.
 *
 * Skips cleanly (exit 0) when no language server is installed for this repo, so
 * it is safe in CI on a machine without one.
 *
 *   node scripts/lsp-check.mjs
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { LspManager, makeLspTools, executeLspTool } from '../packages/agent-runtime/dist/lsp-tools.js';
import { availableServers } from '../packages/agent-runtime/dist/lsp-client.js';

const ROOT = process.cwd();
let failures = 0;

const check = (label, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${String(detail).slice(0, 300)}`);
  }
};

const managers = [];
const newManager = () => {
  const m = new LspManager(ROOT);
  managers.push(m);
  return m;
};

/** Find 1-based line/column of `token`, so tests never hand-count columns. */
function locate(relPath, token, nth = 1) {
  const lines = readFileSync(join(ROOT, relPath), 'utf8').split(/\r?\n/);
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    let from = 0;
    for (;;) {
      const at = lines[i].indexOf(token, from);
      if (at < 0) break;
      if (++seen === nth) {
        return { line: i + 1, column: at + 1 + Math.floor(token.length / 2) };
      }
      from = at + 1;
    }
  }
  throw new Error(`找不到 token "${token}" (第 ${nth} 个) in ${relPath}`);
}

const servers = availableServers(ROOT);
console.log('=== 语言服务器 ===');
if (servers.length === 0) {
  /*
   * Skipping must not look like passing.
   *
   * This exited 0 with a note, so `check:all` could not distinguish "18 assertions passed" from
   * "nothing ran at all" — the LSP tools would be completely unverified and the gate would be green.
   * A skipped check is a hole in the gate, and the only way a hole stays visible is if it is red.
   *
   * `tests/__fixtures`, a container, or a fresh clone without dev dependencies all land here, so the
   * message says exactly what to install.
   */
  console.error('  未安装任何语言服务器，LSP 检查无法执行。');
  console.error('  这不是通过：LSP 相关的 18 项断言一条都没跑。');
  console.error('  安装后重试：pnpm add -w -D typescript-language-server typescript');
  process.exit(1);
}
for (const { spec, resolved } of servers) {
  console.log(`  ${spec.id.padEnd(14)} ${spec.languages.join(', ')}`);
  console.log(`  ${' '.repeat(14)} ${resolved.via}`);
}

const TS_FILE = 'packages/agent-runtime/src/lsp-tools.ts';
const hasTs = servers.some((s) => s.spec.id === 'typescript');

if (hasTs) {
  const manager = newManager();
  const call = (name, args) => executeLspTool(name, args, ROOT, manager);

  console.log('\n=== 客户端正确性 ===');

  // hover
  {
    const p = locate('packages/agent-runtime/src/subagent-tools.ts', 'ToolDefinition');
    const out = String((await call('lsp_hover', { path: 'packages/agent-runtime/src/subagent-tools.ts', ...p }))?.output ?? '');
    check('hover 返回真实类型', /ToolDefinition/.test(out), out);
  }

  // definition — the FIRST structural query, which is the one that used to be
  // wrong while the project was still loading.
  {
    const p = locate(TS_FILE, 'LspServer', 3);
    const out = String((await call('lsp_definition', { path: TS_FILE, ...p }))?.output ?? '');
    console.log(`        ${out}`);
    check('首次 definition 就落在真声明（预热生效）', /lsp-client\.ts:/.test(out), out);
    check('路径无盘符、无 ..\\ 前缀', !/^[a-z]:/i.test(out) && !out.includes('..\\..\\'), out);
  }

  // references
  {
    const p = locate(TS_FILE, 'class LspManager');
    const out = String((await call('lsp_references', {
      path: TS_FILE, line: p.line, column: p.column + 6,
    }))?.output ?? '');
    const lines = out.split('\n').filter((l) => l && l !== '没有结果');
    check('references 找到多处', lines.length >= 2, out);
    check('references 含类声明本身', lines.some((l) => /lsp-tools\.ts:33/.test(l)), out);
  }

  // diagnostics on a deliberately broken file
  const broken = join(ROOT, '_lsp-check-broken.ts');
  const brokenRel = 'packages/agent-runtime/src/_lsp-check-broken.ts';
  const brokenAbs = join(ROOT, brokenRel);
  writeFileSync(brokenAbs, 'export const n: number = "broken";\n', 'utf8');
  try {
    const out = String((await call('lsp_diagnostics', { path: brokenRel }))?.output ?? '');
    console.log(`        ${out.split('\n')[0]}`);
    check('diagnostics 报出类型错误 2322', out.includes('2322'), out);

    // Fix the file. A stale cached result here would report an error that no
    // longer exists, and the agent would "fix" something that is already fine.
    writeFileSync(brokenAbs, 'export const n: number = 42;\n', 'utf8');
    const fixed = String((await call('lsp_diagnostics', { path: brokenRel }))?.output ?? '');
    check('修复后不再报旧错误（缓存按内容失效）', !fixed.includes('2322'), fixed);
    check('修复后报告为干净', /没有诊断信息/.test(fixed), fixed);

    // Break it again, so the reverse direction is covered too.
    writeFileSync(brokenAbs, 'export const n: number = "broken again";\n', 'utf8');
    const rebroken = String((await call('lsp_diagnostics', { path: brokenRel }))?.output ?? '');
    check('再次破坏后能报出新错误', rebroken.includes('2322'), rebroken);
  } finally {
    rmSync(brokenAbs, { force: true });
    rmSync(broken, { force: true });
  }

  // A clean file must not be reported as broken.
  {
    const out = String((await call('lsp_diagnostics', { path: TS_FILE }))?.output ?? '');
    check('干净文件无 ERROR', !/ERROR/.test(out), out);
  }

  // An unchanged file reuses the cached result, but a changed one must not.
  {
    const p = locate(TS_FILE, 'LspServer', 1);
    const out = String((await call('lsp_diagnostics', { path: TS_FILE }))?.output ?? '');
    check('无改动时结果稳定', !/ERROR/.test(out), out);
    void p;
  }

  console.log('\n=== 安全边界 ===');
  // These paths are deliberately hostile inputs, not real paths we use.
  // portability-check:allow
  for (const p of ['../../../Windows/System32/drivers/etc/hosts', '..\\..\\..\\secret.txt', '/etc/passwd']) {
    const r = await call('lsp_diagnostics', { path: p });
    check(`拒绝越界路径 ${p}`, r?.ok === false && /超出工作区/.test(String(r.output)), r?.output);
  }

  console.log('\n=== 降级行为 ===');
  {
    const r = await call('lsp_diagnostics', { path: 'README.md' });
    check('不支持的语言给出明确提示', r?.ok === false && /语言服务器/.test(String(r.output)), r?.output);
  }
  {
    const r = await call('fs_read', { path: 'x' });
    check('非 LSP 工具名返回 null（交给其它分发）', r === null, r);
  }
}

console.log('\n=== Agent 集成 ===');
{
  // The tools must reach the model, or none of the above matters.
  const { Agent } = await import('../packages/agent-runtime/dist/agent.js');
  const cfg = {
    llm: { provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k', maxTokens: 10, temperature: 0, thinkingLevel: 'low' },
    workspace: { root: ROOT },
    kb: {
      dbPath: join(ROOT, '.she', 'lsp-check-kb.sqlite'),
      maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100,
      boostOnAccess: 1.5,
      pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
    },
    skills: { profile: 'dev' },
    automationMode: true,
    server: { port: 0, host: '127.0.0.1' },
    sandbox: {
      shell: 'auto', timeout: 1000, maxOutputBytes: 1000,
      denyDestructiveByDefault: true, allowAllCommands: true,
    },
  };
  const agent = new Agent(cfg, {}, { definitions: [], execute: async () => '' }, null);
  const names = agent.getToolDefinitions().map((d) => d.name);
  const lspTools = names.filter((n) => n.startsWith('lsp_'));
  console.log(`        agent 工具总数 ${names.length}，其中 LSP: ${lspTools.join(', ') || '(无)'}`);
  check('agent 注册了 LSP 工具', lspTools.length === 4, lspTools.join(','));
  check('每个 LSP 工具都有描述', agent.getToolDefinitions()
    .filter((d) => d.name.startsWith('lsp_'))
    .every((d) => typeof d.description === 'string' && d.description.length > 20));
  await agent.dispose();
}

for (const m of managers) await m.dispose();

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
