/**
 * 追加（turn 进行中插话）带附件的 agent 层判据。
 *
 * 这里断言的是"写进历史"这一半：附件随 [用户补充] 一起落进历史（provider 下一轮请求就会带上它）。
 * 排队那一半（turnActive 时进 pendingInterjections、回合边界出队）由既有的 interject 测试与
 * check:lock 覆盖 —— 队列元素现在多带一个 images 字段，出队两处都写了它。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../agent.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'she-interject-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const IMG = () => ({ path: join(dir, 'shot.png'), mime: 'image/png' });

function makeConfig() {
  return {
    llm: { provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k', maxTokens: 100, temperature: 0, thinkingLevel: 'low' },
    workspace: { root: dir },
    kb: { dbPath: join(dir, 'kb.sqlite'), maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100, boostOnAccess: 1.5, pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 } },
    skills: { profile: 'dev' },
    automationMode: true,
    server: { port: 0, host: '127.0.0.1' },
    sandbox: { shell: 'auto', timeout: 1000, maxOutputBytes: 1000, denyDestructiveByDefault: true, allowAllCommands: true },
  } as never;
}

function makeAgent() {
  return new Agent(makeConfig(), {} as never, { definitions: [], execute: async () => '' } as never, null);
}

describe('追加消息能带附件（interject）', () => {
  it('没在跑的一轮：附件跟着 [用户补充] 一起进历史', () => {
    const a = makeAgent();
    a.interject('看这张图', [IMG()]);
    const last = a.getHistory().at(-1)!;
    assert.equal(last.role, 'user');
    assert.equal(String(last.content), '[用户补充] 看这张图');
    assert.deepEqual((last as unknown as { images?: unknown }).images, [IMG()]);
  });

  it('只有附件、没有文字也放行（与 /api/chat 同一条语义）', () => {
    const a = makeAgent();
    a.interject('', [IMG()]);
    const last = a.getHistory().at(-1)!;
    assert.equal(String(last.content), '[用户补充]');
    assert.equal((last as unknown as { images?: unknown[] }).images?.length, 1);
  });

  it('既没文字也没附件：什么都不做（不写一条空消息）', () => {
    const a = makeAgent();
    const before = a.getHistory().length;
    a.interject('   ');
    assert.equal(a.getHistory().length, before);
  });
});
