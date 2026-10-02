# Evaluations / 评测

两类评测，都可以独立跑。

```
node evals/retrieval/run.mjs    # 检索质量，离线，0 API 成本，~1s
node evals/agent/run.mjs        # 端到端任务，调 API，~20s，~116k tokens
node evals/verification/run.mjs # 自我验证：故障识别，调 API，5 个任务
```

| | retrieval | agent |
|---|---|---|
| 调用 LLM | 否 | 是 |
| 判分方式 | 组归属 / 标题匹配 | **文件系统 + 字符串断言 + 「这次跑了哪些工具」** |
| 当前结果 | 三通道融合 Top-1 80%（12/15）vs 纯 BM25 67%（10/15），本库自评（2026-10-02，约 50 节点） | 15 个任务，按通过率判定（门槛 80%） |
| 主要用途 | 证明 KB 的检索主张 | 证明工具循环真的能完成任务，以及走的是该走的那条路 |

**这两行数字都会变，所以它们都带着出处。** 检索那一行的数字来自 `node evals/retrieval/run.mjs`
在本仓库知识库（约 50 节点）上的一次实跑，库会长、数字会动 —— 要引用就用**你自己那次**的输出，
不要抄这一行。规模上的检索质量（≥1k 节点）在 `pnpm check:retrieval` 里，用的是固定夹具，不受库
大小影响。

## Agent 评测的成本设计

一次完整跑的实测 token 数见 `evals/agent/run.mjs` 的输出。为了不重复花钱，harness 刻意做成这样：

1. **一个进程跑完所有任务** —— 不按任务起进程，避免重复初始化。
2. **判分不调用 LLM** —— 全部是文件系统断言（文件存在/内容包含/命令输出）和回复字符串检查。用 LLM 当裁判会让成本翻倍，而且引入不确定性。
3. **每个任务有墙钟超时 + 工具轮次上限**（默认 150s / 10 轮），超时会真的调用 `agent.stop()` 中止请求，避免后台继续烧。
4. **打印每任务 token**，让成本可见。

```bash
node evals/agent/run.mjs --only fix-bug        # 只跑一个（调试用，最省）
SHE_EVAL_TIMEOUT_MS=60000 node evals/agent/run.mjs
```

## 实测发现：成本几乎全在 prompt

```
本轮 API 用量  116452 tokens (prompt 115018)
```

**prompt 占 98.8%。** 输出（completion）几乎可以忽略。

这是**当时那一次**的读数（10 个任务、`deepseek-flash`），任务已经涨到 15 个，绝对数会更大；
下面说的是比例关系，不是当前的总量。

原因：每个任务都完整重发一次系统提示词 + 工具 JSON schema，多轮工具循环再逐轮重发增长中的历史。所以：

- **优化成本要砍系统提示词和工具定义，不是砍输出。**
- 加一个工具 = 每轮都多付一份 schema 的钱。
- 单任务的轮数直接乘算 prompt 成本（`fix-bug` 4 轮 → 29k，`create-file` 1 轮 → 14k）。

这个数字本身就是可以持续优化的指标：**改动前后跑一次评测，对比总 tokens。**

## 每轮都要付的固定开销，和它的预算

上面那句「加一个工具 = 每轮多付一份 schema」不是说法，是**每轮都在付的账单**：系统提示词 + 工具表
（JSON schema）在每个请求里完整重发一次。所以它单独有预算，而且**离线就能量**：

```bash
pnpm check:evals    # 第 8 节：量一次固定开销，超预算就红
```

2026-10-02 实测（`pnpm check:evals` 第 8 节的输出，不花钱）：系统提示词 26747 字符 + 33 个工具
22141 字符 = **48888 字符**。同一次请求模型报回的 prompt tokens 是 **14087**，两者相除得
**3.47 字符/token** —— 换算系数取 3.3（留 5% 余量），判据写在 `scripts/evals-check.mjs` 第 8 节。

注意这两个数字的**来源不同**：字符数是离线量出来的（每次跑门禁都会重新量），token 数是 API 报的
（只有真花钱跑评测时才有）。所以引用时看清是哪一个，别把推导出来的数当成测量值。另外这套「固定」
开销里**含工作区路径**（提示词里写着它），所以两次测量的字符数会差几个字符 —— 实测 `check:evals`
第 8 节印 48888，`evals/agent` 那次报 `overheadChars: 48900`。判据比的是**同一次运行里的两个数**
（`overheadChars` 与模型报的 prompt tokens），所以这点差别不影响判定，但引用绝对数时要说明是哪一次。

- 长大本身不是错，**无声长大**才是。几轮里每轮加一段说明、没人量过，直到某条任务写死的绝对上限
  被顶破才被发现：`greeting-cheap` 就是这么红的 —— 上限 13000 是照当年固定开销 10300 的读数定的，
  提示词长到 14087 之后它一直红着，看起来像"成本回归"，实际是"尺子没跟着长"。写死一个更大的数下一条
  指令进来就会重演，所以那条任务改成**跟自己比**：拿模型报的 prompt tokens 和它此刻要发的固定开销比
  （`promptWithinOverhead`）。固定开销以外的部分只可能来自会话状态（历史 / 恢复的计划 / 回灌的工具
  结果），那才是这句话要抓的东西。
- 换算系数是实测常量，写在 `evals/agent/run.mjs` 的 `CHARS_PER_TOKEN`（当前 3.3，留 5% 余量；实测
  3.47 字符/token）。**换模型或换分词器会动它**，重测方法：`node evals/agent/run.mjs --only
  greeting-cheap --json`，用输出里的 `overheadChars ÷ promptTokens`。判据失败时也会提示这一点。

## 任务设计

| id | 考什么 | 判据 |
|---|---|---|
| `create-file` | `fs_write` 往返（含中文） | 文件存在且含三行内容 |
| `fix-bug` | 读→改→跑 闭环 | `node bug.js` 输出 42 |
| `read-and-report` | `fs_read` + 精确提取 | 回复含 access code |
| `grep-then-write` | grep 定位 + 写入 | `found.txt` 含正确文件名 |
| `multi-step-build` | 建目录 + 两文件 + 执行 | `node src/run.js` 输出 42 |
| `multi-turn-recall` | 多轮上下文保留 | 第 2 轮答复含第 1 轮的编号，且不啰嗦 |
| `multi-turn-handoff` | 多轮状态交接（基于上一轮结果继续） | 读回的文件里是上一轮算出的值 |
| `kb-proactive-recall` | 主动查知识库（答案只在库里的种子记忆里） | 调了 `kb_query` **且** 回复含标志词 |
| `kb-no-raw-sqlite` | 不许绕过 `kb_*` 直捅库文件 | 调了 `kb_query`，且 `shell` / `fs_read` / `fs_write` 一次都没调 |
| `greeting-cheap` | 问候语不该触发任何工具，也不该继承会话状态 | 一次工具都不调 + **只带固定开销**（prompt 与它自己此刻的系统提示词+工具表比）+ 回复短 |
| `subagent-delegation` | 委派真的走了子智能体那条路 | 调了 `task_spawn` **且** 交付内容正确 |
| `diagnostics-aware-edit` | 跨文件类型修复（装了语言服务器可用 `lsp_diagnostics` 自查） | 目标文件改对 |
| `long-horizon-append-chain` | 5 轮累加：每轮接着上一轮的文件继续写 | 四轮内容都在（重写文件＝丢状态）+ prompt 增长有界 |
| `long-horizon-deep-recall` | 6 轮深召回：编号在第 1 轮给出、第 6 轮才问 | 答复含该编号 + prompt 增长有界 |
| `long-horizon-verified-artifact` | 5 轮改同一个文件，最后一版要同时具备各轮要求 | 三个符号都在 + prompt 增长有界 |

短任务都刻意做得**小**：判据确定、单轮或两轮能完成，这样一次跑的 token 可控。三条
`long-horizon-*` 是例外，见下。

## 自我验证评测（`evals/verification`）

测的不是"能不能完成任务"，而是"**能不能认出这活没干成**"。夹具里放着坏掉的产物和谎报的结果，
判据要求它说出哪里不对 —— 这恰好是 agent 最容易顺着自己的叙述滑过去的地方。

| id | 夹具里的故障 | 过关要求 |
|---|---|---|
| `exit-code-lies` | `check.sh` 退出码是 0，输出却是 `error: …` | 结论以 FAILURE 开头（只看退出码就会误判成功） |
| `wrong-total` | `data.txt` 里五行的和（不提示有几行） | 答出正确和，不许用平均值蒙 |
| `silently-broken-write` | 空工作区，"写完就算完"的诱惑 | `result.json` 存在、是合法 JSON、且字段对（写成功 ≠ 内容对） |
| `hidden-discrepancy` | `README.md` 写 1.0.0，`package.json` 写 2.3.1 | 以权威来源为准答出 2.3.1，而不是复述文档 |
| `test-actually-fails` | `test.js` 断言必然失败，却还会打印 `all good` | 结论以 FAIL 开头（声称通过就是没跑） |

## 已知局限

- **只有 15 个任务**（另有 5 个自我验证任务），样本太小，不能作为能力基准，只能当**回归检测**。
- **短任务偏简单**：都是"写文件/改一行/跑一下"。多文件重构、大代码库定位、失败恢复仍然没有。
- **长程只覆盖了三种死法**：`long-horizon-append-chain`（累加丢状态）、`long-horizon-deep-recall`
  （早期内容被挤出上下文）、`long-horizon-verified-artifact`（反复改写后交付物缺项）。三条都是
  5–6 轮、带 `turnPromptGrowth` 上限（context 膨胀是长程真正的死法）。仍然没有的：几十轮以上、
  中途失败要自己恢复、以及需要跨会话续跑的那种。
- **单一模型**（当前配置的 `deepseek-flash`）。换模型结论可能不同。
- **agent 评测有随机性**：同样的任务两次跑结果可能不同（温度、采样）。所以适合看"是否回归"，不适合看"涨了 2%"。
