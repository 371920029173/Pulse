/**
 * The project index: which directories this process has opened.
 *
 * This file is the rail's memory across projects. When it holds two spellings of one directory —
 * `d:\AGI\app` and `D:\AGI\app`, which is exactly what the live machine's index held on
 * 2026-09-27 — the rail builds two session stores and two work-group stores over one state file.
 * Each keeps its own in-memory copy and persists it, so a group written by one is invisible to the
 * other: the sidebar loses groups when a chat from the "other" project is clicked, and the next
 * save writes away the conversations the other copy still had.
 *
 * So: one directory is one entry, however it is spelled.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { knownProjectRoots, rememberProject } from '../projects.js';

const win = process.platform === 'win32';

let dir: string;
let file: string;
let a: string;
let b: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'she-projects-'));
  file = join(dir, 'index', 'projects.json');
  // The index lives in the app directory, so the test writes it to a directory of its own rather
  // than beside the project it is remembering.
  mkdirSync(join(dir, 'index'), { recursive: true });
  a = join(dir, 'alpha');
  b = join(dir, 'beta');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('project index', () => {
  it('lists the current directory first, then remembered ones', () => {
    rememberProject(file, b);
    assert.deepEqual(knownProjectRoots(file, a), [a, b]);
  });

  it('does not remember the same directory twice', () => {
    rememberProject(file, a);
    rememberProject(file, a);
    rememberProject(file, a);
    const roots = JSON.parse(readFileSync(file, 'utf8')).roots as string[];
    assert.equal(roots.filter((r) => r === a).length, 1);
  });

  it('re-remembering moves a directory to the front rather than duplicating it', () => {
    rememberProject(file, a);
    rememberProject(file, b);
    rememberProject(file, a);
    assert.deepEqual(knownProjectRoots(file, a), [a, b]);
  });

  it('forgets a directory that no longer exists', () => {
    rememberProject(file, b);
    rmSync(b, { recursive: true, force: true });
    assert.deepEqual(knownProjectRoots(file, a), [a]);
  });

  it('survives an unreadable index instead of throwing', () => {
    writeFileSync(file, '{ not json', 'utf8');
    assert.deepEqual(knownProjectRoots(file, a), [a]);
    rememberProject(file, b);
    assert.deepEqual(knownProjectRoots(file, a), [a, b]);
  });

  it('collapses two spellings of one directory into one entry', { skip: !win }, () => {
    // The live case: the index held `d:\AGI\_she-live-test` and `D:\AGI\_she-live-test`, and the
    // rail listed the project twice while the two stores overwrote each other.
    const upper = join(dir, 'Alpha');
    const lower = join(dir, 'alpha');
    if (upper === lower) return;
    mkdirSync(upper, { recursive: true });
    writeFileSync(file, JSON.stringify({ roots: [lower, upper] }), 'utf8');
    const roots = knownProjectRoots(file, upper);
    assert.equal(roots.length, 1, `expected one entry, got ${JSON.stringify(roots)}`);
    assert.equal(roots[0].toLowerCase(), lower.toLowerCase());
  });

  it('collapses two spellings when remembering as well', { skip: !win }, () => {
    const upper = join(dir, 'Alpha');
    const lower = join(dir, 'alpha');
    if (upper === lower) return;
    mkdirSync(upper, { recursive: true });
    rememberProject(file, lower);
    rememberProject(file, upper);
    const roots = JSON.parse(readFileSync(file, 'utf8')).roots as string[];
    const matching = roots.filter((r) => r.toLowerCase() === lower.toLowerCase());
    assert.equal(matching.length, 1, `expected one entry, got ${JSON.stringify(matching)}`);
  });

  it('never returns a path that is not there', () => {
    const ghost = join(dir, 'ghost');
    writeFileSync(file, JSON.stringify({ roots: [ghost] }), 'utf8');
    assert.equal(existsSync(ghost), false);
    assert.deepEqual(knownProjectRoots(file, a), [a]);
  });
});
