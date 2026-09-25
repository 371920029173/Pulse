/**
 * `classifyToolResult` — what a tool result means and what to do about it.
 *
 * The samples below are the strings tools in this repository actually produce, quoted from
 * the code that produces them. That matters more than usual here: the classifier is a set
 * of patterns over other people's messages, so a test written from the classifier's own
 * regexes would pass forever while the messages moved underneath it.
 *
 * The cases that motivate the whole module are the ones that used to be invisible or
 * indistinguishable, so they are asserted first and hardest:
 *   - a non-zero exit code, which the old `^Error:` sniff counted as success
 *   - `No matches found`, which read as data when the honest answer is "nothing"
 *   - a refusal, an argument error and a dead endpoint, which all looked alike
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyToolResult, annotateToolResult, isToolFailure } from '../tool-result.js';

describe('成功与空结果', () => {
  it('普通内容是成功，且不加注释', () => {
    const v = classifyToolResult('fs_read', 'line one\nline two');
    assert.equal(v.kind, 'none');
    assert.equal(v.ok, true);
    assert.equal(v.remedy, null);
    assert.equal(isToolFailure(v), false);
    assert.equal(annotateToolResult('line one', v), 'line one', '成功的结果不应被改写');
  });

  it('grep 没匹配是"空"，不是错误也不是数据', () => {
    // sandbox tools.ts: `if (matches.length === 0) return 'No matches found';`
    const v = classifyToolResult('grep', 'No matches found');
    assert.equal(v.kind, 'empty');
    assert.equal(v.ok, false, '没有拿到数据就不能算 ok');
    assert.equal(v.retryable, false, '同样的条件重查不会有别的结果');
    assert.match(String(v.remedy), /不要用同样的条件重查/);
    assert.match(String(v.remedy), /不要把没查到的部分说成已知/);
  });

  it('kb_query 没结果是"空"', () => {
    // agent-runtime kb-tools.ts: `return 'No results found in Group KB.';`
    const v = classifyToolResult('kb_query', 'No results found in Group KB.');
    assert.equal(v.kind, 'empty');
    assert.match(String(v.remedy), /查询本身成功了/);
  });

  it('真正的空字符串是"空"', () => {
    assert.equal(classifyToolResult('fs_read', '').kind, 'empty');
    assert.equal(classifyToolResult('fs_read', '   \n  ').kind, 'empty');
  });

  it('引用了哨兵句子的长输出不会被当成空', () => {
    // The sentinels are anchored whole for exactly this reason: a real result that happens
    // to mention "No matches found" is a result, not an absence.
    const v = classifyToolResult('grep', 'src/a.ts:12: const msg = "No matches found";');
    assert.equal(v.kind, 'none');
    assert.equal(v.ok, true);
  });
});

describe('退出码（旧代码当成成功的那一类）', () => {
  it('非零退出码是失败，且不可重试', () => {
    // sandbox tools.ts: parts.push(`exit code: ${result.exitCode}`)
    const v = classifyToolResult('shell', 'stdout:\nboom\nstderr:\nError: nope\nexit code: 1');
    assert.equal(v.kind, 'nonzero_exit');
    assert.equal(v.ok, false);
    assert.equal(v.retryable, false);
    assert.equal(isToolFailure(v), true, '这正是以前被漏掉的情况');
    assert.match(String(v.remedy), /先读 stderr/);
  });

  it('退出码 0 是成功', () => {
    const v = classifyToolResult('shell', 'stdout:\nok\nexit code: 0');
    assert.equal(v.kind, 'none');
    assert.equal(v.ok, true);
  });

  it('超时的命令优先报超时而不是退出码', () => {
    // tools.ts appends `(timed out)` after the exit code.
    const v = classifyToolResult('shell', 'stdout:\n\nexit code: -1\n(timed out)');
    assert.equal(v.kind, 'timeout');
    assert.equal(v.retryable, true);
  });

  it('退出码取最后一行（前面的是程序自己的输出）', () => {
    /*
     * The status line is appended after stdout and stderr, so an output that merely CONTAINS
     * `exit code: 1` must not have that line read as its own exit status. Found by
     * `tool-result-check.mjs`, which drives real tools rather than restating these rules.
     */
    const forged = classifyToolResult('shell', 'stdout:\nexit code: 1\nexit code: 0');
    assert.equal(forged.kind, 'none', '真正的退出码是最后那个 0');

    const real = classifyToolResult('shell', 'stdout:\nexit code: 0\nexit code: 2');
    assert.equal(real.kind, 'nonzero_exit');
  });

  it('程序自己打印的 (timed out) 不算超时（标记在末尾才算）', () => {
    const v = classifyToolResult('shell', 'stdout:\n(timed out)\nexit code: 0');
    assert.equal(v.kind, 'none', '这是命令打印了这几个字，不是命令被杀掉');
  });

  it('空结果的哨兵句出现在输出中间不算空', () => {
    // The sentinels are anchored whole (`^...$`): a real result that merely mentions the
    // phrase is a result. Otherwise a genuine finding would be discarded as "no data".
    const v = classifyToolResult('t', 'see also: No matches found');
    assert.equal(v.kind, 'none');
    assert.equal(v.ok, true);
  });
});

describe('权限', () => {
  it('沙箱拒绝是权限问题，且明确不可重试、不可绕开', () => {
    // shell.ts: stderr: 'DENIED: destructive command blocked by sandbox policy'
    // tools.ts: return `DENIED: ${result.stderr}`;
    const v = classifyToolResult('shell', 'DENIED: DENIED: destructive command blocked by sandbox policy');
    assert.equal(v.kind, 'permission');
    assert.equal(v.retryable, false);
    assert.match(String(v.remedy), /由用户决定是否放行/);
  });

  it('输出里出现 DENIED 不算拒绝（只有前缀才算）', () => {
    // The failure this guards: `grep DENIED: file` reporting its own search hits would
    // otherwise be classified as the sandbox refusing the call.
    const v = classifyToolResult('grep', 'src/shell.ts:640: stderr: "DENIED: destructive command blocked"');
    assert.equal(v.kind, 'none');
    assert.equal(v.ok, true);
  });
});

describe('失败原因分类', () => {
  const cases = [
    // [producer, result, expected kind]
    ['plan-tools.ts', 'Error: steps are required', 'invalid_args'],
    ['memo-tools.ts', 'Error: title and at least one step are required', 'invalid_args'],
    ['kb-tools.ts', 'Error: item_id 与 groupName 必填', 'invalid_args'],
    ['subagent-tools.ts', 'Error: no usable tasks (each needs a non-empty prompt)', 'invalid_args'],
    ['plan-tools.ts', 'Error: status 不合法（必须是 pending / active / done / blocked / dropped 之一），收到 "x"', 'invalid_args'],
    ['kb-tools.ts', 'Error: 组 "ops" 不存在。现有组：a, b。若确实需要新建，请传 createIfMissing=true。', 'invalid_args'],
    ['sandbox tools.ts', 'Error: 路径不存在: src/nope.ts', 'not_found'],
    ['memo-tools.ts', 'Error: 未找到备忘录 m1', 'not_found'],
    ['kb-tools.ts', 'Error: 未找到条目 item-9', 'not_found'],
    ['plan-tools.ts', 'Error: plan not found (plan_id=p1)', 'not_found'],
    ['fs_read', 'Error: ENOENT: no such file or directory, open \'/srv/app/nope.ts\'', 'not_found'],
    ['sandbox tools.ts', 'Error: unknown tool "nope"', 'unavailable'],
    ['kb-tools.ts', 'Error: unknown KB tool "kb_fake"', 'unavailable'],
    ['plugins.ts', 'Error: plugin tool "x" is not available', 'unavailable'],
    // A refusal that arrives as a thrown Error rather than the `DENIED:` prefix.
    ['shell.ts', 'Error: Path escapes workspace: ../../../etc/passwd', 'permission'],
    ['shell.ts', 'Error: cd 目标在工作区外: C:\\Windows', 'permission'],
    ['ingest-tools.ts', 'Error: 不在工作区（知识入库只允许工作区内的路径）', 'permission'],
    // Well-formed but the state does not allow it: changing the arguments cannot help.
    ['preflight.ts', 'Error: 当前没有可分析的用户请求（这条工具是给收到用户消息的那一轮用的）。', 'precondition'],
    ['batch tools', 'Error: 没有可用的 batch', 'precondition'],
    ['fs_read', 'Error: connect ECONNREFUSED 127.0.0.1:5577', 'service'],
    ['provider', 'Error: fetch failed', 'service'],
    ['shell', 'Error: 连接被拒绝', 'service'],
  ] as const;

  for (const [from, result, kind] of cases) {
    it(`${from} 的失败被归为 ${kind}`, () => {
      assert.equal(classifyToolResult('t', result).kind, kind, result);
    });
  }

  it('每一种失败都给出不同的去路，并且不可重试的都不建议重试', () => {
    const kinds = ['invalid_args', 'permission', 'unavailable', 'not_found', 'precondition', 'empty',
      'service', 'timeout', 'rate_limited', 'nonzero_exit', 'unknown'] as const;
    const samples: Record<string, string> = {
      invalid_args: 'Error: steps are required',
      permission: 'DENIED: nope',
      unavailable: 'Error: unknown tool "x"',
      not_found: 'Error: 路径不存在: x',
      precondition: 'Error: 当前没有可分析的用户请求',
      empty: 'No matches found',
      service: 'Error: connect ECONNREFUSED 1.2.3.4:80',
      timeout: 'exit code: -1\n(timed out)',
      rate_limited: 'Error: OpenAI API error 429: slow down',
      nonzero_exit: 'exit code: 2',
      unknown: 'Error: 某种没见过的问题',
    };
    const remedies = new Set<string>();
    for (const k of kinds) {
      const v = classifyToolResult('t', samples[k]);
      assert.equal(v.kind, k, `${k}: ${samples[k]}`);
      assert.ok(v.remedy && v.remedy.length > 10, `${k} 必须有可执行的去路`);
      remedies.add(String(v.remedy));
    }
    assert.equal(remedies.size, kinds.length, '不同原因的"去路"不能是同一句话');
  });
});

describe('HTTP 状态码（provider 的上报方式）', () => {
  // openai.ts: `throw new Error(\`OpenAI API error ${response.status}: ${errText}\`);`
  const cases = [
    [429, 'rate_limited'],
    [408, 'timeout'],
    [504, 'timeout'],
    [500, 'service'],
    [502, 'service'],
    [503, 'service'],
    [401, 'permission'],
    [403, 'permission'],
    [404, 'unavailable'],
    [400, 'invalid_args'],
    [422, 'invalid_args'],
  ] as const;

  for (const [code, kind] of cases) {
    it(`HTTP ${code} → ${kind}`, () => {
      assert.equal(classifyToolResult('t', `Error: OpenAI API error ${code}: some text`).kind, kind);
    });
  }

  it('限流是可重试的，参数错误不是', () => {
    assert.equal(classifyToolResult('t', 'Error: OpenAI API error 429: x').retryable, true);
    assert.equal(classifyToolResult('t', 'Error: OpenAI API error 400: x').retryable, false);
  });

  it('正文里出现 500 不会被当成服务故障', () => {
    // Only the provider's `API error <code>` shape is read as a status.
    const v = classifyToolResult('grep', 'src/a.ts:500: const port = 500;');
    assert.equal(v.kind, 'none');
  });
});

describe('等人在确认是一个状态，不是失败', () => {
  it('needs_confirm 不算失败', () => {
    const v = classifyToolResult('shell', JSON.stringify({ needs_confirm: true, awaiting: 'user_approval', tool: 'shell' }));
    assert.equal(v.kind, 'none');
    assert.equal(v.remedy, null, '确认门工作正常，不该给模型"失败补救"的话术');
  });

  it('needs_apply 不算失败', () => {
    const v = classifyToolResult('fs_write', JSON.stringify({ needs_apply: { path: 'a.ts', diff: '+x' } }));
    assert.equal(v.kind, 'none');
  });
});

describe('注释的写法', () => {
  it('注释带固定前缀，和工具自己的输出分得开', () => {
    const v = classifyToolResult('t', 'No matches found');
    const out = annotateToolResult('No matches found', v);
    assert.match(out, /^No matches found\n\n\[tool-result\] /);
  });

  it('注释不随重复调用变化（否则卡死检测会失效）', () => {
    // The stuck-loop signature is tool + arguments + the first 500 chars of the result.
    // A remedy containing a timestamp or a counter would make every repeat look different
    // and silently disable detection, so this is asserted rather than assumed.
    const a = annotateToolResult('No matches found', classifyToolResult('t', 'No matches found'));
    const b = annotateToolResult('No matches found', classifyToolResult('t', 'No matches found'));
    assert.equal(a, b);
  });

  it('不用 [系统提示] 作为标记（那是卡死提示的标记）', () => {
    const out = annotateToolResult('x', classifyToolResult('t', 'No matches found'));
    assert.doesNotMatch(out, /\[系统提示\]/);
  });

  it('成功的结果原样返回', () => {
    const v = classifyToolResult('t', 'all good');
    assert.equal(annotateToolResult('all good', v), 'all good');
  });

  it('非字符串结果被序列化后再注释', () => {
    const v = classifyToolResult('t', 'No matches found');
    assert.match(annotateToolResult({ a: 1 }, v), /^\{"a":1\}\n\n\[tool-result\]/);
  });
});
