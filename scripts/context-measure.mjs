/*
 * 一次性测量：上下文天花板救援在一段具体历史上到底压掉了多少。
 * 用 dist 里那份代码（用户实际会跑的），模型是一个本地桩 provider —— 不发外网、不花钱。
 *
 *   node .she/tmp/measure-compaction.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../packages/agent-runtime/dist/agent.js';
import { estimateRequest } from '../packages/agent-runtime/dist/compaction.js';

const dir = mkdtempSync(join(tmpdir(), 'she-measure-'));
const config = {
  llm: { provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k', maxTokens: 100, temperature: 0, thinkingLevel: 'low', contextWindow: 40_000 },
  workspace: { root: dir },
  kb: { dbPath: join(dir, 'kb.sqlite'), maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100, boostOnAccess: 1.5, pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 } },
  skills: { profile: 'dev' },
  automationMode: true,
  server: { port: 0, host: '127.0.0.1' },
  sandbox: { shell: 'auto', timeout: 1000, maxOutputBytes: 1000, denyDestructiveByDefault: true, allowAllCommands: true },
  context: { compression: 'off', allowHistoryReduction: false, autoCompact: true, compactAtShare: 0.8, pricing: { inputPerMillion: 0, outputPerMillion: 0, cachedInputPerMillion: 0 } },
};

let digestCalls = 0;
const provider = {
  name: 'stub',
  async chat(messages) {
    if (messages.some((m) => m.role === 'system' && m.content.includes('压缩成一份摘要'))) {
      digestCalls += 1;
      return { role: 'assistant', content: Array.from({ length: 18 }, (_, i) => `${i + 1}. 这一轮做了什么、决定了什么、还有哪一步没做完。`).join('\n') };
    }
    return { role: 'assistant', content: 'ok' };
  },
};

const a = new Agent(config, {}, { definitions: [], execute: async () => '' }, 'sess-measure');
a.provider = provider;

const blocks = 12;
const bulk = [];
for (let i = 0; i < blocks; i++) {
  bulk.push({ role: 'user', content: `block ${i} ` + 'x'.repeat(10_000) });
  bulk.push({ role: 'assistant', content: `ack ${i}` });
}
a.setHistory(bulk);

/** 和 agent 内部同一套算法：只算不在 messages 里的工具表（系统消息已在 messages[0]）。 */
const OVERHEAD = 23_474;
const beforeTokens = estimateRequest(a.messagesForRequest().messages, OVERHEAD).tokens;
const r = await a.forceCompact('manual');
const afterTokens = estimateRequest(a.messagesForRequest().messages, OVERHEAD).tokens;
const rec = JSON.parse(readFileSync(join(dir, '.she', 'sessions', 'sess-measure', 'compaction.json'), 'utf8'));

console.log(JSON.stringify({
  manualResult: r,
  historyMessages: a.getHistory().length,
  historyChars: a.getHistory().reduce((n, m) => n + m.content.length, 0),
  requestMessagesBefore: bulk.length + 1,
  requestMessagesAfter: a.messagesForRequest().messages.length,
  tokensBefore: beforeTokens,
  tokensAfter: afterTokens,
  keptShare: Number((afterTokens / beforeTokens).toFixed(3)),
  covered: rec.covered,
  nextFingerprint: rec.nextFingerprint,
  digestChars: rec.digest.length,
  digestSource: rec.source,
  digestCalls,
  window: a.getContextStatus().window,
  diskTranscriptIntact: a.getHistory().some((m) => m.content.startsWith('block 0 ')),
}, null, 2));
