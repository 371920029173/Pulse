# 项目地图（流程）

> 这是一条**流程**，不是工具清单。地图的价值不在"有个命令能查"，而在
> **动手之前先定位、改之前先算影响面、干完顺手标注**这三件事变成习惯。

## 0. 在哪找（找不到入口时先看这一节）

地图**没有**叫 `map/` 的文件夹，也**没有**独立页面。入口只有三个：

| 入口 | 怎么用 |
|---|---|
| **界面** | 状态栏「地图」按钮，或命令面板（Ctrl+K）→「项目地图（只读）」 |
| **命令行**（在工作区根下） | `pnpm map:build` 建图；`pnpm map:query tree\|lookup\|whereis\|scope\|impact\|contracts\|verify` 查询 |
| **工具面** | `map_*`（同一份数据） |

**「我没看见地图」= 这个工作区还没建过图。** 地图是**一个工作区一套**：`<工作区>/.she/map/`
只在跑过 `map:build` 的目录里出现；别的仓里找不到 `.she/map` 是正常的，不是坏了。
`.she/` 在 gitignore 里，所以它不会跟着代码走，也不会被别的仓看见。

## 1. 什么时候用（触发条件）

- 接到"要改某个行为"的任务，而不知道它落在哪个包/文件 → `map:query scope "<任务一句话>"`，别一上来 `grep`。
- 要改一个被多人引用的文件 → `map:query impact <路径>`（**值导入**那一栏才是"会运行出错"；"仅类型"只是重编译）。
- 打开陌生文件 → `map:query lookup <路径>`（标签 / 组 / 符号大纲 / 注记 / 相关组结构知识）。
- 要知道"这行为什么是这样" → `lookup` 的「最近改动」或 `git log --follow`。
- 局部回退 → `map:revert`（计划 → 票据 → 快照 → 执行），不要手工 `git checkout`。

## 2. 什么时候不要用

- 已经知道确切路径、只读一个文件：直接 `fs_read`。
- 几百行的小仓：收益小于维护成本。
- 要**推理**（"这段逻辑为什么错"）：地图只回答"在哪、谁在用"。

## 3. 三层防护（出问题时按顺序看）

1. **没有地图** → 面板/CLI 会直接说「还没有地图：先跑 `pnpm map:build`」，不会给你一张空图。
   建图几百毫秒；只建一个子系统可以 `node scripts/map-build.mjs packages`。
2. **有地图但标签是 0 条** → `verify` 会把分数封顶 30 并写「意图检索不可用」。
   这时 `whereis`/`scope` **只能按路径子串匹配**，别指望语义定位；先按路径找，边干边标。
3. **标签过期/来自外部** → 输出里会带「这描述的是更早版本」或「外部收编（来自 …）／取不到」。
   一律**回去读代码**；过期标签比没有标签更坏。

## 4. 三条纪律

1. **过期比缺失更坏**：标签绑内容 sha，内容一变就 `stale`；看到 `stale` 就去读代码。
2. **不确定标成不确定**：契约/依赖边分 `certain` 与 `candidate`；候选当线索，不当事实。
3. **顺手标注，不专门开工**：读完/改完还没标签的文件，用 `annotate` 写
   `label`（≤16 字）+ `what`（一句干什么）+ `when`（**什么时候该读它**）。第三段最省调用。

## 5. 日常节奏

```bash
pnpm map:build                                        # 改了源码之后跑一次（几百毫秒）
pnpm map:query scope "给会话加导出"                     # 锚点 → 会被波及 → 要跑哪些 check
pnpm map:query lookup packages/kb/src/context-window.ts
pnpm map:query impact packages/shared/src/index.ts     # 分「值导入」与「仅类型」两栏
pnpm map:query contracts                               # 确定 / 潜在威胁（带反证条件）/ 无法对账
pnpm map:query verify                                  # 可信度：过期率 / 黑暗角落 / 悬空边 / 坏分片
pnpm map:query adopt <别的工作区根> [--prefix 旧=新]     # 收编：只收引用，改过的才落地
```

## 5.5 批量标注（640 个文件别手写）

```bash
node scripts/map-suggest.mjs --out .she/tmp/notes.json   # 生成候选（只输出，不写盘）
node scripts/map-note.mjs --json .she/tmp/notes.json --dry   # 先看会给什么
node scripts/map-note.mjs --json .she/tmp/notes.json         # 再写
```

候选来自内容本身：测试文件取 `describe/it` 前 3 条，md 取一级标题，脚本/源码取首行注释与导出名。
**没有信号的文件不会产出**（不制造"label 就是文件名"的噪音），那部分才需要人写 `what/when`。

目录**不需要逐条标**：没有人工标签的目录会按子节点聚合出「A、B 等 N 项」，子节点一改它立刻跟着变。

## 5.6 接线（谁用了谁）

每条 import 边都带**具体符号名**：A 用了 B 里的 c，这条边就叫「接线 c」。

```bash
pnpm map:query wiring packages/ui/src/App.tsx        # 这个文件接出去/接进来的线
pnpm map:query wiring --symbol budgetToolResult      # 反查：谁用了这个符号
```

**在哪能看到接线**（客户模型问过这个，写清楚）：

| 在哪 | 怎么用 | 看到什么 |
|---|---|---|
| **工具** | `map_wiring({ path })` 或 `map_wiring({ symbol })` | `A --接线 c--> B` 逐行 |
| **工具** | `map_lookup({ path })` | 结果里的「接线」一节：`→ 目标 接线 x、y`（出去）/ `← 来源 接线 z`（进来） |
| **工具** | `map_impact({ paths })` | 「直接接线（改它先看这些）」：首跳的边名都带符号 |
| **CLI** | `pnpm map:query wiring <文件>` / `--symbol <名字>` | 同上，适合人工排查 |
| **界面** | 状态栏「地图」面板 | **目前只有树**，没有接线视图（还没做，不做成"好像有"） |

改一个函数前先看这里，比 grep 准——它只列真的 import 关系。

## 5.7 工具常驻，地图各工作区独立

- 8 个 `map_*` 在**内建工具表**里 → 每个工作区、每个会话、每个子代理都有（不需要装 MCP）；
- 数据是**每个工作区自己的** `<工作区>/.she/map`；首次调用自动建图。想共用一个库：`SHE_MAP_PATH`（对称 `SHE_KB_PATH`）；
- 每轮请求**末尾**自动带一行 `【工作区地图】…`（文件数/分片/顶层目录 + 工具名），所以"想不起来用"这件事不成问题；
- 老会话不会一直缺工具：服务端比较工具签名，不一致就重建该会话的 agent（代价是丢一次前缀缓存）。

## 5.8 派子代理时怎么给上下文

- **并发**：默认池子 6（`SHE_SUBAGENT_CONCURRENCY` 1..16）。一次 spawn 十个会排队，不会一起炸。
- **即发即走**：`task_spawn({ background: true })` 立刻返回，孩子作为独立会话跑完；
  用 `task_status({ ids })` 看"进行中 / 已结束 / 失败"，数据来自任务板（和界面同一份）。
- **等待**：`shell_wait({ ids: [...], mode: "all" | "any" })` —— 等的是**什么结束**，不是多少秒。
- **父级会替你收窄**：spawn 之前，父级用地图（`map_scope`）和 KB（标题）拼一段"可能落在哪、会被波及什么、
  要跑哪些 check"附在 brief 后面。它标了"未复核"——**以你读到的代码为准**。

## 6. 踩过的坑

- **裸包名 import** 只建到包根的边：查"改 `packages/shared/src/index.ts` 影响谁"要同时看文件级与**包级**。
- **指向 `dist/` 的 import 不建边**（构建产物不在图上），这是故意的。
- **契约图对变量拼接的 URL 无法对账**，它们会单列一栏 —— 不要读成"零问题"。
- **孪生文件**：同一路径在不同分支是两个节点，各带各的标签。
- **地图是实验功能**：字段可能变；改 schema 要升版本并写迁移（见 `docs/project-map-schema.md`）。
