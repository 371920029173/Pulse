/**
 * `plan_list` 的工具定义要和它的行为一致：默认只展开当前计划、其余一行点名，`all: true` 才全量。
 * 定义是模型唯一能看到的说明 —— 行为改了而描述还写着"列出全部"，模型就不会想到传 `all`。
 *
 * 外加 `skill_read` 的两条报错要能被分类（未分类的 `Error:` 会被当成"出了点什么事"）。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPlanTools } from '../plan-tools.js';
import { classifyToolResult } from '../tool-result.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-planlist-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('plan_list 的定义与行为一致', () => {
  it('描述写的是"当前计划 + 一行点名其余，all: true 全量"', () => {
    const def = createPlanTools(dir, 'sess-def').definitions.find((d) => d.name === 'plan_list');
    assert.ok(def);
    assert.equal(
      def!.description,
      'List the current plan in full, plus one line naming the other open plans; pass `all: true` to print every plan.',
    );
  });

  it('参数里有可选的布尔 all', async () => {
    const tools = createPlanTools(dir, 'sess-schema');
    const def = tools.definitions.find((d) => d.name === 'plan_list')!;
    const params = def.parameters as { properties?: Record<string, { type?: string }>; required?: string[] };
    assert.equal(params.properties?.all?.type, 'boolean');
    assert.equal((params.required ?? []).includes('all'), false, 'all 必须是可选的');
    // 声明的参数确实被读到：两个计划时，all=true 比默认多印出另一个。
    await tools.execute('plan_create', { title: '第一个', steps: ['a'] });
    await tools.execute('plan_create', { title: '第二个', steps: ['b'] });
    const all = await tools.execute('plan_list', { all: true });
    assert.match(all, /第一个/);
    assert.match(all, /第二个/);
    assert.notEqual(all, await tools.execute('plan_list', {}));
  });
});

describe('skill_read 的报错有分类', () => {
  it('缺 name 是参数错误', () => {
    const v = classifyToolResult('skill_read', 'Error: skill_read 需要 name（技能索引里列出的名字）。可用：alpha, beta');
    assert.equal(v.kind, 'invalid_args');
  });

  it('索引里没有的名字是 not_found', () => {
    const v = classifyToolResult('skill_read', 'Error: 没有名为「nope」的技能。可用：alpha, beta');
    assert.equal(v.kind, 'not_found');
  });
});
