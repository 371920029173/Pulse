/**
 * 前后对比：一次写操作到底改了什么。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `fs_write` 直通时以前只回一句 `Wrote 812 bytes to app.ts`。这句话对**看清改了什么**没有任何
 * 帮助，而且它连「其实什么都没改」都长得一样 —— 模型把一个文件原样重写一遍，回执同样理直气壮，
 * 于是它接着往下讲「我已经把 X 改好了」。审查的人要么去看完整文件（一个字一个字对），要么相信它。
 *
 * 所以直写路径也要给出前后对比，和走确认门（`PendingPatchStore`）时一样。区别在于**用途不同**：
 * 补丁是给 apply 用的，必须完整；这里是给人（和模型自己）看的，必须短。一份 3000 行文件的
 * 完整 diff 灌进上下文是另一种看不见 —— 真正改动的那三行会被淹掉。
 *
 * 边界与取舍：
 *
 *   - **相同前后缀先裁掉。** 典型的「模型重写整个文件、只改一处」因此缩成几行，而不是整篇。
 *   - **中间那段用 LCS 做最小化**，所以夹杂的改动也能各自成块，而不是被糊成一坨「这里不一样」。
 *   - **改得太多就不再最小化**：区域超过 `MAX_DIFF_LINES` 时只报计数和一块截断的示意。
 *     不是为了省 CPU，而是因为一屏装不下的 diff 在工具回执里没有价值。
 *   - **输出有硬上限**，并且明说被截断 —— 一句「（已截断）」比一个悄悄少了一半的 diff 诚实。
 *
 * 它**不是**给 `git apply` 用的补丁：没有 `\ No newline` 标记、不做上下文行数控制。要做补丁，
 * `patches.ts` 里那个才是。
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** 一行 diff 的取舍：最多这么多内容行，以及最多这么多字符。 */
export const MAX_DIFF_LINES = 40;
export const MAX_DIFF_CHARS = 2400;
/** 中间差异区域超过这个行数就不再逐行最小化，只报计数与示意。 */
const MAX_MINIMIZED_LINES = 400;

export interface ChangeSummary {
  /** `new` 新建、`same` 内容没变、`changed` 有改动。 */
  status: 'new' | 'same' | 'changed';
  added: number;
  removed: number;
  /** 给工具回执用的多行文本，已经带上路径与计数。 */
  text: string;
  /** text 是否因为长度上限而截断。 */
  truncated: boolean;
}

/**
 * 中间区域的逐行最小化 diff，基于 LCS。
 *
 * 只在裁剪后的区域上跑，所以规模是受控的：两边各不超过 `MAX_MINIMIZED_LINES` 才会被调用。
 * 结果按顺序给出，`-` 是被删的原文，`+` 是新增的内容。
 */
function minimalDiff(a: string[], b: string[]): string[] {
  // LCS 表，行数受控（<= 400 × 400 = 160k 格）。
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`-${a[i++]}`);
  while (j < m) out.push(`+${b[j++]}`);
  return out;
}

/** 裁掉相同的开头与结尾，返回 [前缀行数, 中段 a, 中段 b, 后缀行数]。 */
function trimCommon(a: string[], b: string[]) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start
    && end < b.length - start
    && a[a.length - 1 - end] === b[b.length - 1 - end]
  ) end++;
  return {
    start,
    before: a.slice(start, a.length - end),
    after: b.slice(start, b.length - end),
  };
}

/**
 * 把一次写操作压成一段可读的前后对比。
 *
 * `before` 为空串表示新建。返回值里的 `text` 可以直接拼进工具回执。
 */
export function summarizeChange(relPath: string, before: string, after: string): ChangeSummary {
  if (before === after) {
    return {
      status: 'same',
      added: 0,
      removed: 0,
      truncated: false,
      text: `内容与写入前完全相同（${countLines(after)} 行）—— 文件没有变化。`,
    };
  }

  if (before === '') {
    // 新建：完整 diff 只会有 `+` 行，而这些内容模型刚刚自己写出来，回灌一遍纯属浪费上下文。
    return {
      status: 'new',
      added: countLines(after),
      removed: 0,
      truncated: false,
      text: `新建文件（${countLines(after)} 行，${after.length} 字符）。`,
    };
  }

  const a = splitLines(before);
  const b = splitLines(after);
  const { start, before: midA, after: midB } = trimCommon(a, b);

  /*
   * 改得太多：逐行最小化只会产出一屏没有信息量的 +/-。报计数和一段示意更有用 —— 读者需要知道
   * 的是「这次几乎是重写」，而不是逐行读一遍。
   */
  const tooBig = midA.length > MAX_MINIMIZED_LINES || midB.length > MAX_MINIMIZED_LINES;
  const lines = tooBig ? [] : minimalDiff(midA, midB);
  const added = tooBig ? midB.length : lines.filter((l) => l.startsWith('+')).length;
  const removed = tooBig ? midA.length : lines.filter((l) => l.startsWith('-')).length;

  const header = `改动：+${added} −${removed} 行（差异区域从第 ${start + 1} 行开始）`;
  if (tooBig) {
    return {
      status: 'changed',
      added,
      removed,
      truncated: true,
      text: `${header}\n  （改动范围过大，未逐行展开：原 ${midA.length} 行 → 现 ${midB.length} 行）`,
    };
  }

  const shown = lines.slice(0, MAX_DIFF_LINES);
  let body = shown.join('\n');
  let truncated = shown.length < lines.length;
  if (body.length > MAX_DIFF_CHARS) {
    body = body.slice(0, MAX_DIFF_CHARS);
    truncated = true;
  }

  return {
    status: 'changed',
    added,
    removed,
    truncated,
    text: truncated
      ? `${header}\n${body}\n  （对比已截断，共 ${lines.length} 行差异；完整内容见文件）`
      : `${header}\n${body}`,
  };
}

/**
 * 按行切开，空内容算 0 行。
 *
 * 两个细节都影响可读性，而且必须和 diff 用同一套口径，否则「删了 3 行」和正文里那几个 `-` 行
 * 会对不上：
 *
 *   - 空文件是 0 行，不是 `['']` 那 1 行 —— 否则「清空文件」会报成「+1 −3」。
 *   - 结尾的换行不算新的一行。`a\nb\nc\n` 是 3 行，不是 4 行；否则几乎每个正常文件的计数都多 1。
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 行数。与 diff 用同一套口径，见 `splitLines`。 */
function countLines(text: string): number {
  return splitLines(text).length;
}
