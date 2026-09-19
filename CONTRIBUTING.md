# Contributing / 参与开发

> 日常改代码的操作细节（验证命令、注释风格、已知陷阱、加检查的写法）都在
> **[AGENTS.md](AGENTS.md)** —— 那份是给 agent 和新同事的操作约定，这里只讲协作流程。

## 快速开始

```bash
pnpm install
pnpm -r build
pnpm -r test
```

桌面窗口：`SHE.bat`（Windows）或 `./she.sh`（macOS / Linux）。

## 提交前请跑这些

```bash
pnpm check:all                             # 一条命令跑完全部
```

只想快一点时，可以只跑相关的：

```bash
pnpm -r test                               # 单元测试，秒级
pnpm eval                                  # 检索评测（离线，秒级）
pnpm check:data                            # 数据安全（自己起临时服务）
pnpm check:security                        # 安全回归（自己起临时服务，无需先启动任何东西）
pnpm check:shell                           # Shell 引号 + 命令白名单
pnpm check:ui                              # 控件样式一致性
```

**除了两个 eval 之外全部离线、免费**，请务必本地跑过。检查脚本都会自己启动所需的服务，
所以结果不受"你碰巧有没有开着开发服务"影响。

**会花钱的是两个 eval**（一次完整运行约 200k tokens），所以不要求每次提交都跑，但
**改动 agent 循环、工具定义或系统提示词时必须跑**：

```bash
node evals/agent/run.mjs --only fix-bug    # 最省，单任务
node evals/agent/run.mjs                   # 全套 10 个任务
node evals/verification/run.mjs            # 自我验证：会看错就答错的题
```

改提示词/工具要**对比改动前后的 token 用量** —— 提示词和工具 schema 每一轮都会重发，成本几乎全在这里。

## 代码约定

- TypeScript strict。不要用 `any` 绕过类型问题，除非有注释说明为什么。
- **注释解释「为什么」，不解释「是什么」。** 尤其要写清：这里踩过什么坑、为什么不能用更直观的写法。仓库里现有的注释基本都是这个风格，请保持一致。
- 中文和英文注释都可以，跟文件里已有的保持一致。
- 不要引入 `TODO`/`FIXME` 占位 —— 当前仓库是零 TODO 状态，请保持。做不完就说明现状，而不是留一个标记。

## 架构边界（重要）

- `packages/shared` 不允许依赖其他内部包。
- `packages/kb` 不依赖 agent/UI，保持可独立测试。
- 跨包只通过 `@she/shared` 的类型通信。

## 关于知识库的硬性约束

组结构知识库是这个项目的核心主张，有几条**不能破坏**的规则：

1. **不引入 embedding / 向量检索 / 余弦相似度。** 这是刻意的设计选择，不是尚未实现。
2. **不自动把弱边升为因果边。** `co_occurrence` / `temporal` 永远不是 `causal`；`causal_candidate` 需要 `evidence` + `falsifiers`。
3. **检索质量为王**：任何改动检索的打分逻辑，都必须用 `evals/retrieval` 验证没有退化，并说明对 BM25 基线的增益变化。

## 破坏性操作必须确认

**任何会永久删除用户数据的 UI 操作，都必须先确认。**

这条约定来自实际事故：会话列表的 🗑 紧挨着 ×，一次误点就永久删掉对话；壁纸的「移除」同样一点即删。自动化 UI 测试期间这两个都真实触发过，手工操作同样容易误触。

需要确认的操作（列出以便对照）：

| 操作 | 端点 |
|---|---|
| 删除会话 | `DELETE /api/sessions/:id` |
| 删除工作群 | `DELETE /api/cluster/rooms/:id` |
| 移除背景 | `DELETE /api/background` |
| 清空当前对话 | `DELETE /api/chat/history` |
| 删除技能文件 | `DELETE /api/skills/files` |
| 卸载插件 | `DELETE /api/plugins` |

不需要确认的：清空终端滚动缓冲这类**无持久数据**的操作（加确认只会烦人）。

## 提交 PR

- 一个 PR 做一件事。大改动请先开 issue 讨论。
- PR 描述里写：**改了什么、为什么、怎么验证的**。如果行为有变化，贴出验证输出。
- CI 必须全绿。

## 报告问题

请附上：复现步骤、期望行为、实际行为、环境（系统 / Node 版本 / 模型）。涉及检索问题时，**给出具体的查询词和期望结果** —— 「检索不准」这种描述无法定位。
