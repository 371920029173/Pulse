/**
 * 压缩档位（context.compactionLevel）的**配置层**判据。
 *
 * 这里只认"配置读出来的值"：默认 balanced、环境变量能改、写坏的不生效、YAML 能改。
 * 档位→阈值（保守 0.7 / 平衡 0.8 / 激进 0.9）的映射在 agent.ts，由 check:context 第 8 节
 * 按真 server 验（能改、能读回、写坏的不生效、回到平衡就回到 0.8）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../config.js';

let dir = '';
const KEYS = ['SHE_CONTEXT_COMPACTION_LEVEL', 'SHE_ENV_FILE'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'she-level-'));
  writeFileSync(join(dir, '.env'), '', 'utf8');
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.SHE_ENV_FILE = join(dir, '.env');
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('压缩档位（config）', () => {
  it('默认是 balanced', () => {
    assert.equal(loadConfig(dir).context.compactionLevel, 'balanced');
  });

  it('环境变量能改，且大小写不敏感', () => {
    process.env.SHE_CONTEXT_COMPACTION_LEVEL = 'Aggressive';
    assert.equal(loadConfig(dir).context.compactionLevel, 'aggressive');
  });

  it('写坏的不生效，保留默认', () => {
    process.env.SHE_CONTEXT_COMPACTION_LEVEL = 'whatever';
    assert.equal(loadConfig(dir).context.compactionLevel, 'balanced');
  });

  it('YAML 里能改', () => {
    writeFileSync(join(dir, 'she.config.yaml'), 'context:\n  compactionLevel: conservative\n', 'utf8');
    assert.equal(loadConfig(dir).context.compactionLevel, 'conservative');
  });
});
