#!/usr/bin/env node

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig } from '@she/shared';
import type {
  SheConfig,
  MemoryNode,
  ActivationTrace,
  KBQueryResult,
  StreamChunk,
  ToolCall,
  ToolDefinition,
  LLMMessage,
  PulseSeed,
  PulseHop,
} from '@she/shared';
import {
  red, green, yellow, blue, cyan, magenta, dim, bold, underline,
  boldRed, boldGreen, boldCyan, boldYellow, boldMagenta, boldBlue, dimYellow,
  icons, spinner, box, progressBar, activationBar, badge, table,
} from './ui.js';

// ─── ASCII Logo ───

const LOGO = `
  ╔═══════════════════════════════════════════════╗
  ║                                               ║
  ║   ██████╗ ██╗   ██╗██╗     ███████╗███████╗   ║
  ║   ██╔══██╗██║   ██║██║     ██╔════╝██╔════╝   ║
  ║   ██████╔╝██║   ██║██║     ███████╗█████╗     ║
  ║   ██╔═══╝ ██║   ██║██║     ╚════██║██╔══╝     ║
  ║   ██║     ╚██████╔╝███████╗███████║███████╗   ║
  ║   ╚═╝      ╚═════╝ ╚══════╝╚══════╝╚══════╝   ║
  ║                                               ║
  ║   Local coding agent · PulseSeed KB           ║
  ║                                               ║
  ╚═══════════════════════════════════════════════╝`;

const VERSION = '0.1.0';

// ─── Arg parsing ───

interface ParsedArgs {
  command: string;
  subcommand: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0] ?? '',
    subcommand: positional[1] ?? '',
    positional: positional.slice(2),
    flags,
  };
}

// ─── Dynamic import interfaces ───

interface KBStoreInterface {
  close(): void;
}

interface IngestResult {
  groupsCreated: number;
  memoriesAdded: number;
}

interface GroupKBEngineInterface {
  ingestDirectory(dirPath: string): void;
  ingestFile(filePath: string): MemoryNode;
  query(text: string, opts?: { budget?: number }): KBQueryResult;
  createGroup(name: string, parentId?: string): unknown;
  addMemory(groupId: string, kind: string, title: string, content: string, metadata?: Record<string, unknown>): MemoryNode;
}

interface SandboxShellInterface {
  exec(command: string): Promise<unknown>;
}

interface ToolSetInterface {
  definitions: ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}

interface AgentInterface {
  chat(
    message: string,
    onChunk?: (chunk: StreamChunk) => void,
  ): Promise<LLMMessage>;
  getToolDefinitions(): ToolDefinition[];
  clearHistory(): void;
  getHistory(): LLMMessage[];
}

interface GroupTreeNode {
  name: string;
  memoryCount: number;
  children: GroupTreeNode[];
}

interface TopAccessedMemory {
  title: string;
  kind: string;
  accessCount: number;
}

interface KBStatsResult {
  totalGroups: number;
  totalMemories: number;
  totalEdges: number;
  dormancyRatio: number;
  topAccessed: TopAccessedMemory[];
  groupTree: GroupTreeNode;
  [key: string]: unknown;
}

// ─── Helpers ───

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function printError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n  ${red('Error:')} ${message}\n`);
  if (err instanceof Error && err.stack && process.env.SHE_LOG_LEVEL === 'debug') {
    process.stderr.write(`${dim(err.stack)}\n`);
  }
  process.stderr.write('\n');
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map(line => pad + line).join('\n');
}

function summarizeArgs(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson) as Record<string, unknown>;
    const entries = Object.entries(parsed);
    if (entries.length === 0) return '()';
    const parts = entries.slice(0, 3).map(([k, v]) => {
      const val = typeof v === 'string'
        ? (v.length > 40 ? v.slice(0, 37) + '...' : v)
        : JSON.stringify(v);
      return `${k}=${val}`;
    });
    if (entries.length > 3) parts.push('...');
    return `(${parts.join(', ')})`;
  } catch {
    return argsJson.length > 60 ? argsJson.slice(0, 57) + '...' : argsJson;
  }
}

async function initKB(config: SheConfig): Promise<{ store: KBStoreInterface; engine: GroupKBEngineInterface }> {
  const { mkdirSync, existsSync: fsExists } = await import('node:fs');
  const { dirname: pathDirname } = await import('node:path');
  const dbDir = pathDirname(config.kb.dbPath);
  if (!fsExists(dbDir)) mkdirSync(dbDir, { recursive: true });

  const kbMod = await import('@she/kb') as unknown as Record<string, any>;
  const store = new kbMod.KBStore(config.kb.dbPath) as KBStoreInterface;
  const engine = new kbMod.GroupKBEngine(store, config.kb) as GroupKBEngineInterface;
  return { store, engine };
}

// ─── Help ───

function printHelp(): void {
  console.log(boldCyan(LOGO));
  console.log('');
  console.log(bold(`  Pulse v${VERSION}`) + dim(' — local coding agent'));
  console.log(dim('  A local coding agent with PulseSeed knowledge base retrieval.\n'));

  console.log(bold('  USAGE'));
  console.log(`    ${cyan('she')} ${dim('<command>')} ${dim('[options]')}\n`);

  console.log(bold('  COMMANDS'));
  const cmds: [string, string][] = [
    ['chat',              'Start an interactive chat session with the agent'],
    ['kb ingest <path>',  'Ingest a file or directory into the knowledge base'],
    ['kb query <text>',   'Query the knowledge base with PulseSeed retrieval'],
    ['kb stats',          'Display knowledge base statistics and tree'],
    ['doctor',            'Run system health checks'],
    ['server',            'Start the local API server'],
    ['help',              'Show this help message'],
  ];
  for (const [cmd, desc] of cmds) {
    console.log(`    ${green(cmd.padEnd(22))} ${desc}`);
  }

  console.log(`\n${bold('  IN-CHAT COMMANDS')}`);
  const chatCmds: [string, string][] = [
    ['/clear',   'Clear conversation history'],
    ['/history', 'Show message history'],
    ['/tools',   'List available tools'],
    ['/exit',    'Exit the chat session'],
    ['/quit',    'Exit the chat session'],
  ];
  for (const [cmd, desc] of chatCmds) {
    console.log(`    ${yellow(cmd.padEnd(22))} ${desc}`);
  }

  console.log(`\n${dim('  Docs: https://github.com/she-agent')}`);
  console.log(`${dim('  Config: she.config.yaml | $SHE_* env vars')}\n`);
}

// ─── Doctor ───

async function runDoctor(): Promise<void> {
  console.log('');
  console.log(indent(box(bold('Pulse Doctor') + dim(' — System Health Check'), cyan('diagnostic')), 2));
  console.log('');

  const checks: { label: string; ok: boolean; detail: string }[] = [];

  const nodeVer = process.versions.node;
  const nodeMajor = parseInt(nodeVer.split('.')[0], 10);
  checks.push({
    label: 'Node.js >= 20',
    ok: nodeMajor >= 20,
    detail: nodeMajor >= 20 ? `v${nodeVer}` : `v${nodeVer} ${red('(requires >= 20)')}`,
  });

  const configNames = ['she.config.yaml', 'config.yaml', 'she.config.yml', 'config.yml'];
  const foundConfig = configNames.find(name => existsSync(resolve(process.cwd(), name)));
  checks.push({
    label: 'Config file found',
    ok: true,
    detail: foundConfig ? foundConfig : 'using defaults',
  });

  let config: SheConfig;
  try {
    config = loadConfig();
  } catch {
    config = loadConfig();
  }

  const hasKey = !!config.llm.apiKey;
  const maskedKey = hasKey
    ? config.llm.apiKey.slice(0, 3) + '****' + config.llm.apiKey.slice(-4)
    : 'not set';
  checks.push({
    label: 'API key configured',
    ok: hasKey,
    detail: hasKey ? `${config.llm.provider}: ${maskedKey}` : `${config.llm.provider}: ${red('not set')}`,
  });

  const wsExists = existsSync(config.workspace.root);
  checks.push({
    label: 'Workspace accessible',
    ok: wsExists,
    detail: config.workspace.root,
  });

  const dbDir = resolve(config.kb.dbPath, '..');
  const dbExists = existsSync(config.kb.dbPath);
  const dbDirExists = existsSync(dbDir);
  checks.push({
    label: 'KB database writable',
    ok: dbExists || dbDirExists,
    detail: dbExists
      ? `exists: ${config.kb.dbPath}`
      : dbDirExists
        ? 'directory writable, will create on first use'
        : `parent dir missing: ${dbDir}`,
  });

  let gitVersion = '';
  try {
    gitVersion = execSync('git --version', { encoding: 'utf-8', timeout: 5000 }).trim();
  } catch {
    /* git not found */
  }
  checks.push({
    label: 'git available',
    ok: !!gitVersion,
    detail: gitVersion || 'git not found in PATH',
  });

  const maxLabel = Math.max(...checks.map(c => c.label.length));
  for (const check of checks) {
    const icon = check.ok ? icons.pass : icons.fail;
    const label = check.label.padEnd(maxLabel + 2);
    const detail = dim(check.detail);
    console.log(`  ${icon} ${label} ${detail}`);
  }

  const passed = checks.filter(c => c.ok).length;
  const total = checks.length;
  console.log('');
  if (passed === total) {
    console.log(boldGreen(`  All ${total} checks passed!`) + green(' System is ready.\n'));
  } else {
    const failed = total - passed;
    console.log(yellow(`  ${passed}/${total} checks passed. `) + red(`${failed} issue(s) found.\n`));
  }
}

// ─── KB Ingest ───

async function runKBIngest(targetPath: string): Promise<void> {
  if (!targetPath) {
    process.stderr.write(`\n  ${red('Error:')} please provide a path to ingest.\n`);
    process.stderr.write(`  Usage: ${cyan('she kb ingest <path>')}\n\n`);
    process.exit(1);
  }

  const fullPath = resolve(process.cwd(), targetPath);
  if (!existsSync(fullPath)) {
    process.stderr.write(`\n  ${red('Error:')} path not found: ${fullPath}\n\n`);
    process.exit(1);
  }

  const config = loadConfig();
  const sp = spinner('Initializing knowledge base...');

  try {
    const { store, engine } = await initKB(config);
    const isDir = statSync(fullPath).isDirectory();
    const startTime = Date.now();

    if (isDir) {
      sp.update(`Ingesting directory: ${cyan(targetPath)}...`);
    } else {
      sp.update(`Ingesting file: ${cyan(targetPath)}...`);
    }

    if (isDir) {
      engine.ingestDirectory(fullPath);
    } else {
      engine.ingestFile(fullPath);
    }
    const elapsed = Date.now() - startTime;

    sp.stop(`  ${icons.pass} ${boldGreen('Ingestion complete!')}`);
    console.log('');
    console.log(indent(box([
      `${bold('Path:')}         ${fullPath}`,
      `${bold('Type:')}         ${isDir ? 'directory' : 'file'}`,
      `${bold('Time:')}         ${dim(formatMs(elapsed))}`,
    ].join('\n'), green('results')), 2));
    console.log('');

    store.close();
  } catch (err) {
    sp.stop(`  ${icons.fail} ${boldRed('Ingestion failed')}`);
    printError(err);
    process.exit(1);
  }
}

// ─── KB Query ───

async function runKBQuery(queryText: string): Promise<void> {
  if (!queryText) {
    process.stderr.write(`\n  ${red('Error:')} please provide a query.\n`);
    process.stderr.write(`  Usage: ${cyan('she kb query <query text>')}\n\n`);
    process.exit(1);
  }

  const config = loadConfig();
  const sp = spinner('Querying knowledge base with PulseSeed...');

  try {
    const { store, engine } = await initKB(config);
    const result: KBQueryResult = engine.query(queryText);

    sp.stop();

    if (result.nodes.length === 0) {
      console.log(yellow('\n  No results found.\n'));
      store.close();
      return;
    }

    console.log(bold(`\n  ${cyan(String(result.nodes.length))} result(s) for "${dim(queryText)}"\n`));
    console.log(dim('  ' + '─'.repeat(60)));

    for (let i = 0; i < result.nodes.length; i++) {
      const node = result.nodes[i];
      const trace = result.traces.find(t => t.nodeId === node.id);
      printQueryResultNode(node, trace, i + 1);
    }

    if (result.pulseSeeds.length > 0) {
      console.log(boldMagenta('\n  PulseSeed Traces:\n'));
      for (const seed of result.pulseSeeds) {
        printPulseSeedTrace(seed);
      }
    }

    console.log(dim('  ' + '─'.repeat(60)));
    console.log(`  ${bold('Found')} ${cyan(String(result.nodes.length))} ${bold('nodes across')} ${cyan(String(result.groupsVisited.length))} ${bold('groups in')} ${cyan(formatMs(result.queryTimeMs))}`);
    console.log(dim(`  Scanned ${result.totalNodesScanned} total nodes, ${result.pulseSeeds.length} pulse seeds fired`));
    console.log('');

    store.close();
  } catch (err) {
    sp.stop(`  ${icons.fail} ${boldRed('Query failed')}`);
    printError(err);
    process.exit(1);
  }
}

function printQueryResultNode(node: MemoryNode, trace: ActivationTrace | undefined, index: number): void {
  const kindBadge = badge(node.kind);
  const preview = node.content.length > 200
    ? node.content.slice(0, 200) + dim('…')
    : node.content;

  const level = trace?.activationLevel ?? 0;
  const bar = activationBar(level);

  console.log('');
  console.log(`  ${dim(`${index}.`)} ${kindBadge} ${bold(node.title)}`);
  console.log(`     ${dim(preview)}`);
  console.log(`     ${dim('activation:')} ${bar} ${bold(level.toFixed(3))}`);

  if (trace && trace.groupPath.length > 0) {
    const groupStr = trace.groupPath.join(` ${dim('/')} `);
    console.log(`     ${dim('group path:')} ${groupStr}`);
  }

  if (trace && trace.pulseSeeds.length > 0) {
    const seedStr = trace.pulseSeeds
      .map(s => `${magenta(s.origin)}${dim(`(e=${s.energy.toFixed(2)}, hop=${s.hop})`)}`)
      .join(dim(', '));
    console.log(`     ${dim('seeds:')} ${seedStr}`);
  }

  console.log(`     ${dim(`id:${node.id}  accessed:${node.accessCount}x  dormant:${node.isDormant}`)}`);
}

function printPulseSeedTrace(seed: PulseSeed): void {
  const energyColor = seed.energy >= 0.7 ? green : seed.energy >= 0.3 ? yellow : red;
  console.log(`  ${icons.seed} ${magenta(seed.origin)} ${dim(`id:${seed.id}`)} ${dim('energy:')}${energyColor(seed.energy.toFixed(3))} ${dim(`hop:${seed.hop}`)}`);

  if (seed.path.length > 0) {
    for (const hop of seed.path) {
      printHop(hop);
    }
  }
  console.log('');
}

function printHop(hop: PulseHop): void {
  const arrow = dim('→');
  const energyDelta = hop.energyAfter - hop.energyBefore;
  const deltaStr = energyDelta >= 0 ? green(`+${energyDelta.toFixed(3)}`) : red(energyDelta.toFixed(3));
  const edgeLabel = hop.edgeKind ? dim(`[${hop.edgeKind}]`) : '';
  console.log(`    ${dim(hop.fromId.slice(0, 8))} ${arrow} ${dim(hop.toId.slice(0, 8))} ${edgeLabel} ${dim('energy:')}${deltaStr}`);
}

// ─── KB Stats ───

async function runKBStats(): Promise<void> {
  const config = loadConfig();
  const sp = spinner('Loading KB statistics...');

  try {
    const { store, engine } = await initKB(config);
    const kbStore = (engine as any)['store'] ?? store;
    const rawStats = kbStore.getStats ? kbStore.getStats() : { totalGroups: 0, totalMemories: 0, totalEdges: 0 };
    const stats = { ...rawStats, dormancyRatio: 0, topAccessed: [], groupTree: null } as unknown as KBStatsResult;

    sp.stop();

    console.log('');
    console.log(indent(box(bold('Knowledge Base Statistics'), cyan('she kb')), 2));
    console.log('');

    const overview = [
      ['Total groups', cyan(String(stats.totalGroups ?? 0))],
      ['Total memories', cyan(String(stats.totalMemories ?? 0))],
      ['Total edges', cyan(String(stats.totalEdges ?? 0))],
      ['Dormancy ratio', yellow(((stats.dormancyRatio ?? 0) * 100).toFixed(1) + '%')],
    ];
    for (const [label, value] of overview) {
      console.log(`  ${bold(label.padEnd(20))} ${value}`);
    }
    console.log('');

    if (stats.topAccessed && stats.topAccessed.length > 0) {
      console.log(bold('  Top Accessed Memories:\n'));
      const rows = stats.topAccessed.slice(0, 10).map((m: TopAccessedMemory, i: number) => [
        String(i + 1),
        m.title.length > 40 ? m.title.slice(0, 37) + '...' : m.title,
        badge(m.kind),
        String(m.accessCount),
      ]);
      console.log(indent(table(['#', 'Title', 'Kind', 'Accessed'], rows), 4));
      console.log('');
    }

    if (stats.groupTree) {
      console.log(bold('  Group Tree:\n'));
      printGroupTree(stats.groupTree, 4, 0, 3);
      console.log('');
    }

    store.close();
  } catch (err) {
    sp.stop(`  ${icons.fail} ${boldRed('Failed to load stats')}`);
    printError(err);
    process.exit(1);
  }
}

function printGroupTree(node: GroupTreeNode, indentLevel: number, depth: number, maxDepth: number): void {
  if (depth >= maxDepth) return;

  const prefix = ' '.repeat(indentLevel);
  let branch: string;
  if (depth === 0) {
    branch = cyan('◉');
  } else {
    branch = dim('├── ');
  }
  const memCount = dim(`(${node.memoryCount} memories)`);
  console.log(`${prefix}${branch} ${bold(node.name)} ${memCount}`);

  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const isLast = i === node.children.length - 1;
    const childPrefix = depth === 0 ? '' : (isLast ? '    ' : dim('│   '));
    const nextIndent = indentLevel + (depth === 0 ? 2 : childPrefix.length);
    printGroupTree(child, nextIndent, depth + 1, maxDepth);
  }
}

// ─── Chat ───

async function runChat(): Promise<void> {
  const config = loadConfig();

  console.log(boldCyan(LOGO));
  console.log('');
  console.log(bold(`  Pulse v${VERSION}`) + dim(' — interactive mode'));
  console.log(dim('  Type /help for in-chat commands, /exit to quit.\n'));

  const sp = spinner('Initializing agent...');

  let agent: AgentInterface;
  let tools: ToolDefinition[] = [];

  try {
    const { mkdirSync: mkDir, existsSync: fsEx } = await import('node:fs');
    const { dirname: pDir } = await import('node:path');
    const dbDir = pDir(config.kb.dbPath);
    if (!fsEx(dbDir)) mkDir(dbDir, { recursive: true });

    const kbMod = await import('@she/kb') as unknown as Record<string, any>;
    const sandboxMod = await import('@she/sandbox') as unknown as Record<string, any>;
    const agentMod = await import('@she/agent-runtime') as unknown as Record<string, any>;

    const kbStore = new kbMod.KBStore(config.kb.dbPath);
    const kbEngine = new kbMod.GroupKBEngine(kbStore, config.kb);
    const sandbox = new sandboxMod.SandboxShell(config.workspace.root, config.sandbox);
    const sandboxTools = sandboxMod.createTools(sandbox, config.workspace.root, {
      kbDbPath: config.kb.dbPath,
    });

    agent = new agentMod.Agent(config, kbEngine, sandboxTools) as AgentInterface;
    tools = agent.getToolDefinitions();

    sp.stop(`  ${icons.pass} ${green('Agent ready.')} ${dim(`(${tools.length} tools loaded)`)}\n`);
  } catch (err) {
    sp.stop(`  ${icons.fail} ${boldRed('Initialization failed')}`);
    printError(err);
    process.exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const history: LLMMessage[] = [];

  const promptStr = `${boldCyan('you')} ${cyan(bold('▸'))} `;

  while (true) {
    let userInput: string;
    try {
      userInput = await rl.question(promptStr);
    } catch {
      break;
    }

    const trimmed = userInput.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('/')) {
      const slashCmd = trimmed.toLowerCase();
      if (slashCmd === '/exit' || slashCmd === '/quit') {
        console.log(dim('\n  Goodbye! 👋\n'));
        break;
      }
      if (slashCmd === '/clear') {
        history.length = 0;
        agent.clearHistory();
        console.log(dim('  History cleared.\n'));
        continue;
      }
      if (slashCmd === '/history') {
        printHistory(history);
        continue;
      }
      if (slashCmd === '/tools') {
        printTools(tools);
        continue;
      }
      if (slashCmd === '/help') {
        printChatHelp();
        continue;
      }
      console.log(yellow(`  Unknown command: ${trimmed}`));
      console.log(dim('  Type /help for available commands.\n'));
      continue;
    }

    history.push({ role: 'user', content: trimmed });

    try {
      let streamStarted = false;

      const response = await agent.chat(trimmed, (chunk: StreamChunk) => {
        switch (chunk.type) {
          case 'text':
            if (!streamStarted) {
              process.stdout.write('\n  ');
              streamStarted = true;
            }
            process.stdout.write(green(chunk.content ?? ''));
            break;
          case 'tool_call_start': {
            const name = chunk.toolCall?.function?.name ?? 'unknown';
            const argsPart = chunk.toolCall?.function?.arguments
              ? summarizeArgs(chunk.toolCall.function.arguments)
              : '';
            process.stdout.write(`\n  ${dimYellow(`${icons.gear} calling ${name}${argsPart}...`)}`);
            break;
          }
          case 'tool_call_delta':
            break;
          case 'tool_call_end': {
            const resultSnippet = chunk.content
              ? (chunk.content.length > 100 ? chunk.content.slice(0, 97) + '...' : chunk.content)
              : '';
            if (resultSnippet) {
              process.stdout.write(`\n  ${yellow(resultSnippet)}`);
            }
            break;
          }
          case 'error':
            process.stdout.write(`\n  ${red(`Error: ${chunk.error ?? 'unknown'}`)}`);
            break;
          case 'done':
            break;
        }
      });

      process.stdout.write('\n\n');

      if (response.content && response.content.includes('kb_query') || response.tool_calls?.some(tc => tc.function.name.includes('kb'))) {
        // intentionally left empty — trace display handled through onChunk
      }

      history.push(response);
    } catch (err) {
      process.stdout.write('\n');
      if (err instanceof Error && 'denied' in err) {
        console.log(red(`  ${icons.fail} DENIED: ${err.message}\n`));
      } else {
        printError(err);
      }
    }
  }

  rl.close();
}

function printHistory(history: LLMMessage[]): void {
  if (history.length === 0) {
    console.log(dim('  No history yet.\n'));
    return;
  }
  console.log(bold('\n  Conversation History:\n'));
  for (const msg of history) {
    const roleColors: Record<string, (t: string) => string> = {
      user: boldCyan,
      assistant: green,
      tool: yellow,
      system: dim,
    };
    const colorFn = roleColors[msg.role] ?? dim;
    const roleLabel = colorFn(msg.role.padEnd(12));
    const preview = msg.content.length > 120 ? msg.content.slice(0, 117) + '...' : msg.content;
    console.log(`  ${roleLabel} ${preview}`);
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        console.log(`  ${dim('             ')}${dimYellow(`${icons.gear} ${tc.function.name}${summarizeArgs(tc.function.arguments)}`)}`);
      }
    }
  }
  console.log('');
}

function printTools(tools: ToolDefinition[]): void {
  if (tools.length === 0) {
    console.log(dim('  No tools available.\n'));
    return;
  }
  console.log(bold('\n  Available Tools:\n'));
  for (const tool of tools) {
    const dangerous = tool.isDangerous ? red(' [dangerous]') : '';
    console.log(`  ${cyan(bold(tool.name))}${dangerous}`);
    console.log(`  ${dim(tool.description)}\n`);
  }
}

function printChatHelp(): void {
  console.log('');
  console.log(indent(box([
    `${yellow('/clear')}    Clear conversation history`,
    `${yellow('/history')}  Show message history`,
    `${yellow('/tools')}    List available tools`,
    `${yellow('/help')}     Show this help`,
    `${yellow('/exit')}     Exit the chat session`,
    `${yellow('/quit')}     Exit the chat session`,
  ].join('\n'), bold('Chat Commands')), 2));
  console.log('');
}

// ─── Server ───

async function runServer(): Promise<void> {
  const config = loadConfig();

  console.log('');
  console.log(indent(box([
    `${bold('Pulse API Server')}`,
    '',
    `${dim('Host:')}  ${config.server.host}`,
    `${dim('Port:')}  ${config.server.port}`,
  ].join('\n'), green('starting')), 2));
  console.log('');

  try {
    // dynamically import server - may not resolve at compile time
    const serverModule: Record<string, any> = await (Function('return import("@she/server")')() as Promise<Record<string, any>>);
    const startFn = serverModule.startServer ?? serverModule.default?.startServer;
    if (!startFn) {
      throw new Error('Could not find startServer export in @she/server');
    }
    await startFn(config);
  } catch (err) {
    printError(err);
    process.exit(1);
  }
}

// ─── Main ───

async function main(): Promise<void> {
  const { command, subcommand, positional } = parseArgs(process.argv);

  switch (command) {
    case 'chat':
      await runChat();
      break;
    case 'kb':
      switch (subcommand) {
        case 'ingest':
          await runKBIngest(positional[0] ?? '');
          break;
        case 'query':
          await runKBQuery(positional.join(' '));
          break;
        case 'stats':
          await runKBStats();
          break;
        default:
          process.stderr.write(`\n  ${red('Unknown kb subcommand:')} ${subcommand || '(none)'}\n`);
          process.stderr.write(`  Usage: ${cyan('she kb <ingest|query|stats>')}\n\n`);
          process.exit(1);
      }
      break;
    case 'doctor':
      await runDoctor();
      break;
    case 'server':
      await runServer();
      break;
    case 'help':
    case '':
      printHelp();
      break;
    default:
      process.stderr.write(`\n  ${red('Unknown command:')} ${command}\n`);
      process.stderr.write(`  Run ${cyan('she help')} for usage.\n\n`);
      process.exit(1);
  }
}

main().catch((err) => {
  printError(err);
  process.exit(1);
});
