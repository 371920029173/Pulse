/*
 * 一次性探测：真端点在"提示词超过窗口"时到底说什么，以及我们的分类器认不认得。
 *
 * 为什么值得花这一次钱：`isContextOverflowError` 是整条救援的触发点 —— 它把"太长"和限流/超时分开，
 * 认错的两边都有代价（不认 = 会话卡死；乱认 = 为一次限流白付一次全价压缩）。桩模型能测形状，测不了
 * 真措辞与真窗口。
 *
 *   node .she/tmp/live-overflow-probe.mjs [字符数]
 *
 * 太长的请求会被 4xx 拒绝，通常不计费；接受的请求按输入计价（百萬 token 几毛钱量级）。
 */
import { loadConfig } from '../packages/shared/dist/index.js';
import { OpenAIProvider } from '../packages/agent-runtime/dist/index.js';
import { isContextOverflowError } from '../packages/agent-runtime/dist/compaction.js';

const size = Number(process.argv[2]) || 600_000;
const config = loadConfig();
console.log(`端点 ${config.llm.baseUrl} · 模型 ${config.llm.model} · 提示词 ${size} 字符 ≈ ${Math.round(size / 3.47)} tokens`);

const provider = new OpenAIProvider(config.llm.apiKey, config.llm.baseUrl, config.llm.model, 64, 0, 'low');

try {
  const started = Date.now();
  const reply = await provider.chat([{ role: 'user', content: `请只回复 ok。\n\n${'x'.repeat(size)}` }]);
  console.log(`端点接受了它（${Date.now() - started}ms）：窗口比这更大。回复长度 ${reply.content.length}。`);
} catch (err) {
  const text = err instanceof Error ? err.message : String(err);
  console.log('原始报错（前 800 字）：');
  console.log(text.slice(0, 800));
  console.log('');
  console.log('isContextOverflowError =', isContextOverflowError(err));
}
