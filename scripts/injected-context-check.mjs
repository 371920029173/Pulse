/*
 * 判据：落盘的历史里不许出现"只在请求里存在"的注入块。
 *
 * 现场（2026-11-03，AGI 工作区 sess_07899ec9494d）：两个 compressed 归档里出现了
 * 【本轮自动召回】/【这轮常用的工具】/【工作区地图】，逐个核对落在 assistant 内容里（模型复述）。
 * 之后每次压缩都会把它带进摘要，越滚越大 —— 界面看起来就像"模型在念系统提示"。
 *
 * 这里直接测那个清洗函数本身：给它一段带注入块的话，输出里不该再有块，别的文字要原样留着。
 */
const { stripInjectedContext } = await import('../packages/agent-runtime/dist/injected-context.js');

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
  if (!ok) failed++;
};

const dirty = [
  '我先看一下这段代码。',
  '',
  '【本轮自动召回】3 条（在改代码）。id: a, b, c —— 不够就 kb_query 补查。',
  '',
  '【工作区地图】573 文件 / 40 分片｜顶层：packages, docs',
  '',
  '然后我发现问题在 A 处。',
].join('\n');

const clean = stripInjectedContext(dirty);
check('【关键】注入块被剔掉', !/【本轮自动召回】|【工作区地图】/.test(clean), clean.slice(0, 80));
check('真正的正文原样保留', clean.includes('我先看一下这段代码') && clean.includes('然后我发现问题在 A 处'), '');
check('没有留下成串空行', !/\n{3,}/.test(clean), JSON.stringify(clean.slice(0, 60)));

const untouched = '这一段没有任何注入块，应该一字不改。';
check('干净文本不被改动', stripInjectedContext(untouched) === untouched, '');

console.log(failed ? `\n${failed} 项 FAIL` : '\n全部 PASS');
process.exit(failed ? 1 : 0);
