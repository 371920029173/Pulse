/* 判据：C 项目的 #include "x.h" 要成为「接线 x.h」；系统头 <stdio.h> 不建边。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMap, mapWiring } from '../index.js';

test('C 项目：#include "sched.h" 成为「接线 sched.h」，系统头不建边', () => {
  const dir = mkdtempSync(join(tmpdir(), 'she-c-'));
  try {
    const run = (a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
    run(['init', '-q']);
    run(['config', 'user.email', 'c@t']);
    run(['config', 'user.name', 'c']);
    mkdirSync(join(dir, '01_KERNEL'), { recursive: true });
    writeFileSync(join(dir, '01_KERNEL', 'sched.h'), '#pragma once\nint schedule(void);\n');
    writeFileSync(
      join(dir, '01_KERNEL', 'sched.c'),
      '#include <stdio.h>\n#include "sched.h"\nint schedule(void) { return 0; }\n',
    );
    run(['add', '-A']);
    run(['commit', '-qm', 'init']);

    buildMap({ root: dir, branch: 'main' });
    const hits = mapWiring(dir, { path: '01_KERNEL/sched.c' });
    assert.equal(hits.length, 1, `应只有一条接线（系统头不算），实际 ${hits.length}`);
    assert.equal(hits[0]!.to, '01_KERNEL/sched.h');
    assert.equal(hits[0]!.label, '接线 sched.h');
    assert.deepEqual(hits[0]!.symbols, ['sched.h']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
