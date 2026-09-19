/**
 * Syntax highlighting for code blocks and diffs.
 *
 * Uses `highlight.js` with EXPLICIT language registration rather than the full
 * bundle: the package ships ~190 grammars, and importing `highlight.js` wholesale
 * pulls all of them into the bundle. Only the languages a coding agent actually
 * renders are registered below — adding one costs a grammar, not a framework.
 *
 * Synchronous by design (unlike TextMate-based highlighters): the transcript
 * renders many blocks per frame, and an async highlighter would need loading
 * states, causing a visible flash on every streamed code block.
 */

import hljs from 'highlight.js/lib/core';

// Core languages — import order does not matter, registration does.
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import rust from 'highlight.js/lib/languages/rust';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import dockerfile from 'highlight.js/lib/languages/dockerfile';

const REGISTERED: Record<string, unknown> = {
  javascript, typescript, python, json, bash, powershell, css, xml, markdown,
  yaml, sql, rust, go, java, csharp, cpp, diff, ini, dockerfile,
};

for (const [name, lang] of Object.entries(REGISTERED)) {
  hljs.registerLanguage(name, lang as never);
}

/** Aliases so fenced blocks written in any common style resolve. */
const ALIAS: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  html: 'xml',
  svg: 'xml',
  vue: 'xml',
  md: 'markdown',
  yml: 'yaml',
  toml: 'ini',
  cfg: 'ini',
  conf: 'ini',
  patch: 'diff',
  'c++': 'cpp',
  hpp: 'cpp',
  h: 'cpp',
  cs: 'csharp',
  golang: 'go',
  rs: 'rust',
  postgres: 'sql',
  psql: 'sql',
  docker: 'dockerfile',
};

function resolve(lang: string): string | null {
  const l = lang.trim().toLowerCase();
  if (!l) return null;
  const target = ALIAS[l] ?? l;
  return target in REGISTERED ? target : null;
}

/**
 * Highlight `code`, returning HTML.
 *
 * Falls back to the plain escaped text when the language is unknown, so an
 * unrecognised fence still renders legibly instead of losing its formatting.
 */
export function highlight(code: string, lang: string): { html: string; known: boolean } {
  const target = resolve(lang);
  if (!target) return { html: '', known: false };
  try {
    return { html: hljs.highlight(code, { language: target, ignoreIllegals: true }).value, known: true };
  } catch {
    return { html: '', known: false };
  }
}

/** Languages offered for highlighting, for docs/debugging. */
export function registeredLanguages(): string[] {
  return Object.keys(REGISTERED).sort();
}
