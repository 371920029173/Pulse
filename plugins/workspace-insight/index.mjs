/**
 * workspace-insight — give the agent a way to size up an unfamiliar project.
 *
 * Why a plugin rather than a built-in: this is convenience tooling, not core
 * agent machinery. Keeping it here also exercises the plugin runtime end to end
 * (manifest → loaded module → callable tool) on every install.
 *
 * Only reads through `ctx`, so it declares just the `read` permission.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', '.she', '.venv', '__pycache__']);

/** Extensions worth counting as source. */
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt', '.scala',
  '.sh', '.ps1', '.sql', '.css', '.scss', '.html', '.vue', '.svelte',
]);

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export const tools = [
  {
    name: 'ws_overview',
    description:
      'Summarise the workspace: file count, lines by extension, the largest files, and the '
      + 'most recently modified files. Use this to orient yourself in an unfamiliar project '
      + 'before making changes.',
    parameters: {
      type: 'object',
      properties: {
        maxDepth: { type: 'number', description: 'How deep to walk (default 6)' },
        topN: { type: 'number', description: 'How many largest / newest files to list (default 8)' },
      },
    },
  },
];

tools[0].run = async (args, ctx) => {
  const maxDepth = Math.max(1, Math.min(12, Number(args.maxDepth) || 6));
  const topN = Math.max(1, Math.min(40, Number(args.topN) || 8));

  let files = 0;
  let dirs = 0;
  let skipped = 0;
  const byExt = new Map();     // ext -> { files, lines }
  const all = [];              // { path, size }

  /** Walk with an explicit depth budget so a huge tree cannot hang the call. */
  const walk = (rel, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = ctx.listDir(rel);
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel === '.' ? e.name : `${rel}/${e.name}`;
      if (e.type === 'dir') {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) { skipped++; continue; }
        dirs++;
        walk(child, depth + 1);
        continue;
      }
      const dot = e.name.lastIndexOf('.');
      const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : '';
      if (!CODE_EXT.has(ext)) continue;
      files++;
      all.push({ path: child, size: e.size });

      // Counting lines means reading the file; skip anything large so the tool
      // stays fast on a repository with a few big generated files.
      if (e.size > 512 * 1024) continue;
      try {
        const text = ctx.readFile(child, 512 * 1024);
        const lines = text.length ? text.split('\n').length : 0;
        const cur = byExt.get(ext) ?? { files: 0, lines: 0 };
        cur.files++;
        cur.lines += lines;
        byExt.set(ext, cur);
      } catch { /* unreadable or binary: counted as a file, no line stats */ }
    }
  };

  ctx.log(`scanning workspace (depth<=${maxDepth})`);
  walk('.', 1);

  const totalLines = [...byExt.values()].reduce((n, v) => n + v.lines, 0);
  const out = [];
  // The path is part of the answer. A summary that does not name its root
  // cannot be told apart from a scan of the previous workspace.
  out.push(`工作区 ${ctx.workspaceRoot}`);
  out.push(`工作区概览`);
  out.push(`  源码文件 ${files} 个（跳过 ${skipped} 个目录），共 ${totalLines} 行`);
  out.push(`  目录 ${dirs} 个`);
  out.push('');

  const langRows = [...byExt.entries()].sort((a, b) => b[1].lines - a[1].lines).slice(0, 10);
  if (langRows.length) {
    out.push(`按语言（前 ${langRows.length}）:`);
    for (const [ext, v] of langRows) {
      out.push(`  ${ext.padEnd(8)} ${String(v.files).padStart(4)} 文件  ${String(v.lines).padStart(7)} 行`);
    }
    out.push('');
  }

  const largest = [...all].sort((a, b) => b.size - a.size).slice(0, topN);
  if (largest.length) {
    out.push(`最大的文件（前 ${largest.length}）:`);
    for (const f of largest) out.push(`  ${humanSize(f.size).padStart(8)}  ${f.path}`);
    out.push('');
  }

  out.push('提示：这些只是规模信息。要理解结构，接着读入口文件和 README。');
  return out.join('\n');
};
