import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import ts from 'typescript';

export type SymbolKind = 'function' | 'class' | 'method' | 'interface' | 'type' | 'const' | 'enum' | 'other';

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  preview: string;
  /** Nesting depth for outline UI (0 = top-level). */
  depth?: number;
}

export type OutlineEngine = 'typescript-ast' | 'heuristic';

const SKIP = new Set([
  'node_modules', 'dist', 'build', '.git', '.she', 'release', 'coverage', '.next', 'out',
]);

const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.cs',
]);

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function previewLine(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  let end = text.indexOf('\n', index);
  if (end < 0) end = text.length;
  return text.slice(start, end).trim().slice(0, 120);
}

function lineOfPos(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function previewAt(sf: ts.SourceFile, pos: number): string {
  const { line } = sf.getLineAndCharacterOfPosition(pos);
  const start = sf.getPositionOfLineAndCharacter(line, 0);
  const text = sf.text;
  let end = text.indexOf('\n', start);
  if (end < 0) end = text.length;
  return text.slice(start, end).trim().slice(0, 120);
}

/** Real AST outline for TS/JS — tree-sitter-class structure without native grammars. */
function outlineWithTypescript(absPath: string, relPath: string, content: string): CodeSymbol[] {
  const lower = absPath.toLowerCase();
  const scriptKind =
    lower.endsWith('.tsx') || lower.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.jsx')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(absPath, content, ts.ScriptTarget.Latest, true, scriptKind);
  const out: CodeSymbol[] = [];
  const pathNorm = relPath.replace(/\\/g, '/');

  const push = (name: string | undefined, kind: SymbolKind, node: ts.Node, depth: number) => {
    if (!name || name.length > 80) return;
    out.push({
      name,
      kind,
      path: pathNorm,
      line: lineOfPos(sf, node.getStart(sf)),
      preview: previewAt(sf, node.getStart(sf)),
      depth,
    });
  };

  const visitClassLike = (node: ts.ClassLikeDeclaration | ts.InterfaceDeclaration, depth: number) => {
    for (const member of node.members) {
      if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
        const n = ts.isConstructorDeclaration(member)
          ? 'constructor'
          : (member.name && ts.isIdentifier(member.name) ? member.name.text : undefined);
        push(n, 'method', member, depth + 1);
      } else if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
        const init = member.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          push(member.name.text, 'method', member, depth + 1);
        }
      } else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        if (member.name && ts.isIdentifier(member.name)) push(member.name.text, 'method', member, depth + 1);
      }
    }
  };

  const visit = (node: ts.Node, depth: number) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      push(node.name.text, 'function', node, depth);
    } else if (ts.isClassDeclaration(node) && node.name) {
      push(node.name.text, 'class', node, depth);
      visitClassLike(node, depth);
      return; // don't double-walk members as top-level
    } else if (ts.isInterfaceDeclaration(node)) {
      push(node.name.text, 'interface', node, depth);
      visitClassLike(node, depth);
      return;
    } else if (ts.isTypeAliasDeclaration(node)) {
      push(node.name.text, 'type', node, depth);
    } else if (ts.isEnumDeclaration(node)) {
      push(node.name.text, 'enum', node, depth);
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          push(decl.name.text, 'const', decl, depth);
        }
      }
    } else if (ts.isExportAssignment(node) && ts.isArrowFunction(node.expression)) {
      push('default', 'function', node, depth);
    }

    ts.forEachChild(node, (child) => visit(child, depth));
  };

  visit(sf, 0);
  return dedupe(out).slice(0, 400);
}

function outlineHeuristic(absPath: string, relPath: string, content: string): CodeSymbol[] {
  const ext = extname(absPath).toLowerCase();
  const out: CodeSymbol[] = [];
  const push = (name: string, kind: SymbolKind, idx: number) => {
    if (!name || name.length > 80) return;
    out.push({
      name,
      kind,
      path: relPath.replace(/\\/g, '/'),
      line: lineOf(content, idx),
      preview: previewLine(content, idx),
      depth: 0,
    });
  };

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const patterns: Array<{ re: RegExp; kind: SymbolKind; g: number }> = [
      { re: /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, kind: 'function', g: 1 },
      { re: /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, kind: 'function', g: 1 },
      { re: /\bexport\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g, kind: 'class', g: 1 },
      { re: /\bclass\s+([A-Za-z_$][\w$]*)/g, kind: 'class', g: 1 },
      { re: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g, kind: 'interface', g: 1 },
      { re: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g, kind: 'type', g: 1 },
      { re: /\b(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/g, kind: 'enum', g: 1 },
      { re: /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b)/g, kind: 'const', g: 1 },
    ];
    for (const { re, kind, g } of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) push(m[g], kind, m.index);
    }
  } else if (ext === '.py') {
    for (const { re, kind } of [
      { re: /^def\s+([A-Za-z_]\w*)\s*\(/gm, kind: 'function' as SymbolKind },
      { re: /^async def\s+([A-Za-z_]\w*)\s*\(/gm, kind: 'function' as SymbolKind },
      { re: /^class\s+([A-Za-z_]\w*)\s*[:(]/gm, kind: 'class' as SymbolKind },
    ]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) push(m[1], kind, m.index);
    }
  } else if (ext === '.go') {
    for (const { re, kind } of [
      { re: /^func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)\s*\(/gm, kind: 'function' as SymbolKind },
      { re: /^type\s+([A-Za-z_]\w*)\s+struct\b/gm, kind: 'class' as SymbolKind },
      { re: /^type\s+([A-Za-z_]\w*)\s+interface\b/gm, kind: 'interface' as SymbolKind },
    ]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) push(m[1], kind, m.index);
    }
  } else if (ext === '.rs') {
    for (const { re, kind } of [
      { re: /\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g, kind: 'function' as SymbolKind },
      { re: /\b(?:pub\s+)?struct\s+([A-Za-z_]\w*)/g, kind: 'class' as SymbolKind },
      { re: /\b(?:pub\s+)?enum\s+([A-Za-z_]\w*)/g, kind: 'enum' as SymbolKind },
      { re: /\b(?:pub\s+)?trait\s+([A-Za-z_]\w*)/g, kind: 'interface' as SymbolKind },
    ]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(content))) push(m[1], kind, m.index);
    }
  }

  return dedupe(out).slice(0, 400);
}

function dedupe(out: CodeSymbol[]): CodeSymbol[] {
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = s.name + ':' + s.line + ':' + s.kind;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Structural outline.
 * TS/JS uses the TypeScript AST (tree-sitter-class fidelity). Other languages use heuristics.
 * Not embedding RAG.
 */
export function outlineFile(absPath: string, relPath: string, content: string): CodeSymbol[] {
  const ext = extname(absPath).toLowerCase();
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    try {
      return outlineWithTypescript(absPath, relPath, content);
    } catch {
      return outlineHeuristic(absPath, relPath, content);
    }
  }
  return outlineHeuristic(absPath, relPath, content);
}

export function outlineEngineFor(absPath: string): OutlineEngine {
  const ext = extname(absPath).toLowerCase();
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext) ? 'typescript-ast' : 'heuristic';
}

export function outlinePath(workspaceRoot: string, rel: string): { symbols: CodeSymbol[]; engine: OutlineEngine } {
  const abs = join(workspaceRoot, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return { symbols: [], engine: 'heuristic' };
  if (!CODE_EXT.has(extname(abs).toLowerCase())) return { symbols: [], engine: 'heuristic' };
  let content = '';
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    return { symbols: [], engine: 'heuristic' };
  }
  if (content.length > 1_500_000) content = content.slice(0, 1_500_000);
  const relNorm = rel.replace(/\\/g, '/');
  return {
    symbols: outlineFile(abs, relNorm, content),
    engine: outlineEngineFor(abs),
  };
}

/** Workspace symbol search by name substring. Capped walk — not RAG. */
export function suggestSymbols(workspaceRoot: string, query: string, limit = 30): CodeSymbol[] {
  const q = (query || '').trim().toLowerCase();
  const hits: CodeSymbol[] = [];
  const maxFiles = 400;
  let filesSeen = 0;

  function walk(dir: string) {
    if (hits.length >= limit || filesSeen >= maxFiles) return;
    let ents: string[] = [];
    try {
      ents = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of ents) {
      if (hits.length >= limit || filesSeen >= maxFiles) return;
      if (SKIP.has(name) || name.startsWith('.')) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!CODE_EXT.has(extname(name).toLowerCase())) continue;
      if (st.size > 800_000) continue;
      filesSeen++;
      let content = '';
      try {
        content = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const rel = relative(workspaceRoot, abs).replace(/\\/g, '/');
      for (const sym of outlineFile(abs, rel, content)) {
        if (q && !sym.name.toLowerCase().includes(q) && !rel.toLowerCase().includes(q)) continue;
        hits.push(sym);
        if (hits.length >= limit) return;
      }
    }
  }

  walk(workspaceRoot);
  hits.sort((a, b) => {
    const ae = q && a.name.toLowerCase().startsWith(q) ? 0 : 1;
    const be = q && b.name.toLowerCase().startsWith(q) ? 0 : 1;
    if (ae !== be) return ae - be;
    return a.name.localeCompare(b.name);
  });
  return hits.slice(0, limit);
}
