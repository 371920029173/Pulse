/**
 * Task-file loading and validation, shared by every eval harness and by the offline check that
 * guards them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * A malformed task costs an API call to discover. `{"type": "fileContain"}` — one letter short —
 * runs the model, then grades nothing and reports "未知判据类型", so the failure looks like a
 * behaviour problem when it is a typo. Everything asserted here is a property of the JSON, so it
 * can be checked for free, before any money is spent, and in CI where there is no key at all.
 *
 * It lives in its own module rather than inside one runner because there are two harnesses plus a
 * check script that all need the same answer. Two copies of "which check types exist" would drift,
 * and the copy that drifts is always the one nobody runs.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from 'node:fs';

/** Assertion types the end-to-end harness can grade (see evals/agent/run.mjs `gradeOne`). */
export const AGENT_CHECKS = new Set([
  'fileContains',
  'commandOutput',
  'replyContains',
  'replyLengthBelow',
  'usageBelow',
  /*
   * 「这次请求只带了固定开销」——比 token 上限耐久的那条。
   *
   * `usageBelow` 数的是一个绝对值，提示词长大它就过期，而且是静默过期（一条红着的任务看起来
   * 像成本回归，其实是天花板没人重测）。这条比的是同一个时刻的两样东西：模型报的 prompt
   * tokens，和这个 agent 此刻要发的固定开销。多出来的部分只可能来自会话状态 —— 那才是要抓的。
   * 详见 evals/agent/run.mjs 里 `promptWithinOverhead` 的注释。
   */
  'promptWithinOverhead',
  'fileAbsent',
  // Long-horizon: last turn's prompt vs the first turn's, to catch a context that keeps growing.
  'turnPromptGrowth',
  /*
   * Which tools actually ran.
   *
   * `usageBelow` and reply assertions both grade the RESULT, and some tasks are about the METHOD:
   * "greetings must not call any tool", "delegation must go through `task_spawn`". Grading those by
   * outcome is how a task ends up green while doing the opposite of what it is named after — the
   * subagent task passed for months while opening the files itself, because `fileContains` cannot
   * see who read them. Both checks read the same tool-call list the agent can hand to a caller.
   */
  'toolCallsAtMost',
  'toolCallsInclude',
  /*
   * Tools that must NOT have run.
   *
   * The complement of `toolCallsInclude`, and needed for the same reason: some rules are about a
   * path that must not be taken. "The answer is in the KB, and it was reached through `kb_query`
   * rather than by poking the sqlite file" is a statement about two tools — one that must appear
   * and two that must not — and a bare call count cannot say which of them ran.
   */
  'toolCallsExclude',
  /*
   * 「这次运行**真的压过一次**」—— 自证前提的那条。
   *
   * 压缩相关的判据最容易变成"什么都没测却一直绿"：对话没到阈值就压根没压过，而回复里恰好带着
   * 那个事实（因为它还在最近的上下文里）。于是任务绿着，而它名字里那件事一次都没发生。
   * 这条判据把前提本身变成断言：没压过就判红，并在 detail 里说清"该把窗口调小"。
   * 读的是 agent 自己的上下文状态（`getContextStatus()`），不是从日志里猜的。
   */
  'contextCompacted',
]);

/** Assertion types the verification harness can grade (see evals/verification/run.mjs). */
export const VERIFY_CHECKS = new Set(['replyContains', 'replyLacks', 'fileContains']);

/** The individual assertions of a task: either the single `check`, or every entry of its `all`. */
export function checksOf(task) {
  const c = task?.check;
  if (!c) return [];
  return Array.isArray(c.all) ? c.all : [c];
}

/** How many turns a task really has: `turns` is a sequence, `prompt` is a single turn. */
export function turnCount(task) {
  return Array.isArray(task?.turns) ? task.turns.length : 1;
}

/**
 * Everything wrong with a task list, as human-readable lines. Empty means it is safe to run.
 *
 * Deliberately returns all problems rather than the first: fixing a typo one API call at a time is
 * exactly the loop this is meant to avoid.
 */
export function validateTasks(list, opts = {}) {
  const {
    knownChecks = AGENT_CHECKS,
    longHorizonPattern = /^long-horizon/,
    // Four turns is where "horizon" starts meaning something: two turns is a handoff, and the
    // behaviours worth measuring (a fact surviving unrelated work, state accumulating in a file)
    // do not show up until there are several chances to lose them.
    longHorizonMinTurns = 4,
  } = opts;

  const problems = [];
  const seen = new Set();

  for (const t of list) {
    if (!t || typeof t !== 'object') { problems.push('有一个任务不是对象'); continue; }
    if (!t.id) { problems.push('有任务没有 id'); continue; }
    if (seen.has(t.id)) problems.push(`${t.id}: id 重复`);
    seen.add(t.id);

    if (typeof t.prompt !== 'string' && !Array.isArray(t.turns)) {
      problems.push(`${t.id}: 既没有 prompt 也没有 turns`);
    }
    if (Array.isArray(t.turns)) {
      if (t.turns.length === 0) problems.push(`${t.id}: turns 是空数组`);
      if (t.turns.some((x) => typeof x !== 'string' || !x.trim())) {
        problems.push(`${t.id}: turns 里有空轮次`);
      }
    }
    if (!t.check || (!t.check.type && !Array.isArray(t.check.all))) {
      problems.push(`${t.id}: 没有判据`);
    }
    if (Array.isArray(t.check?.all) && t.check.all.length === 0) {
      problems.push(`${t.id}: all 是空数组（等于没有判据）`);
    }

    for (const [name, body] of Object.entries(t.fixtures ?? {})) {
      /*
       * 夹具写到盘上是文本。非字符串会被静默 stringify 成 "[object Object]"，任务随后会因为与模型
       * 无关的原因失败 —— 所以形状要在**花掉一次 API 调用之前**判掉。
       *
       * 唯一的例外是**生成式夹具** `{ lines, prefix }`：有的判据要的就是一大块内容（"读一个很大的
       * 文件把上下文推过阈值"），而把几万字符的正文原样写进 tasks.json 会让那个文件不能读也不能改。
       * 生成"大"只需要两个数字，且每次跑出来的字节完全一样。形状写坏了照样判掉。
       */
      const generated = body && typeof body === 'object' && !Array.isArray(body)
        && Number.isInteger(body.lines) && body.lines >= 0
        && (body.prefix === undefined || typeof body.prefix === 'string');
      if (typeof body !== 'string' && !generated) {
        problems.push(`${t.id}: 夹具 ${name} 既不是字符串，也不是 { lines, prefix } 形状`);
      }
    }

    /*
     * `kb` seeds memories before the run, so a task can ask about something the model has never
     * seen. Without it, "does it query the KB before answering" is unobservable in a fresh
     * workspace — and the task would pass on the answer being in a file or in the conversation.
     *
     * Checked for the same reason as fixtures: a shape error costs an API call to discover, and an
     * empty `content` would seed a memory that says nothing while the task looks fine.
     */
    if (t.kb !== undefined) {
      if (!Array.isArray(t.kb)) {
        problems.push(`${t.id}: kb 不是数组`);
      } else {
        t.kb.forEach((m, i) => {
          if (!m || typeof m !== 'object') { problems.push(`${t.id}: kb[${i}] 不是对象`); return; }
          for (const field of ['groupName', 'title', 'content']) {
            if (typeof m[field] !== 'string' || !m[field].trim()) {
              problems.push(`${t.id}: kb[${i}] 的 ${field} 缺失或为空`);
            }
          }
        });
      }
    }

    for (const c of checksOf(t)) {
      if (!c || typeof c !== 'object') { problems.push(`${t.id}: 判据不是对象`); continue; }
      if (!knownChecks.has(c.type)) problems.push(`${t.id}: 未知判据类型 ${c.type}`);
      if (c.type === 'turnPromptGrowth' && !(Number(c.max) > 0)) {
        problems.push(`${t.id}: turnPromptGrowth 需要正数 max`);
      }
      /*
       * `max: 0` is the interesting case here ("no tool call at all"), so this cannot be a truth
       * check: `!Number(0)` is true and would reject the one value that matters most.
       */
      if (c.type === 'toolCallsAtMost' && !(Number.isInteger(c.max) && c.max >= 0)) {
        problems.push(`${t.id}: toolCallsAtMost 需要 0 或正整数 max`);
      }
      if (c.type === 'toolCallsInclude' && !(typeof c.tool === 'string' && c.tool.trim())) {
        problems.push(`${t.id}: toolCallsInclude 需要非空 tool`);
      }
      if (c.type === 'toolCallsExclude') {
        if (!Array.isArray(c.tools) || c.tools.length === 0) {
          problems.push(`${t.id}: toolCallsExclude 需要非空 tools 数组`);
        } else if (c.tools.some((x) => typeof x !== 'string' || !x.trim())) {
          problems.push(`${t.id}: toolCallsExclude 的 tools 里有空项`);
        }
      }
    }

    /*
     * A "long-horizon" task with two turns is not a horizon, and the name is the only thing telling
     * a reader it is supposed to be one. Checked here so the label cannot quietly drift away from
     * what the task does.
     */
    if (longHorizonPattern.test(t.id) && turnCount(t) < longHorizonMinTurns) {
      problems.push(`${t.id}: 名字是长程任务，但只有 ${turnCount(t)} 轮（至少 ${longHorizonMinTurns} 轮）`);
    }
  }

  return problems;
}

/** Read a task file, with an error that says which file and which offset — not just "Unexpected token". */
export function loadTasks(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`读不到任务文件 ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`任务文件不是合法 JSON ${file}: ${err.message}`);
  }
  const tasks = parsed?.tasks;
  if (!Array.isArray(tasks)) throw new Error(`任务文件里没有 tasks 数组: ${file}`);
  return tasks;
}
