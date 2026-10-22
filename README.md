# Pulse（SHE v2）

一个**本地优先**的编码智能体：跑在你自己的机器上，用你自己的模型 key，工作区就是它的沙箱。
它把"改代码"当作一件可验证的事——每一步有工具、有证据、有门禁，而不是一段看起来很对的文字。

- **本地优先**：会话、知识库、地图、日志全部落在工作区的 `.she/` 里；不经过任何中转服务。
- **自带验证**：`pnpm check:offline` 一条命令跑完构建、单元套件、离线评测与二十余项结构检查。
- **可换模型**：OpenAI 兼容接口 + 备选提供方；推理强度、上下文窗口按模型登记。
- **可扩展**：工具、插件、技能（skill）、定时任务、讨论群（多角色协作）都是一等公民。

---

## 它解决什么问题

多数编码助手卡在三个地方，这里都当作一等问题处理：

| 问题 | 这里的做法 |
|---|---|
**"不知道哪里是干什么的"** | 项目地图：整仓骨架 + 每文件一句话标签 + 组结构（目录/包/层/功能四轴）+ 接线（谁用了谁的哪个符号） |
**"改坏了才发现"** | 动手前算影响面：反向依赖（分**值导入**与**仅类型**）+ 该跑哪些 check；改完由门禁判定 |
**"上下文一到上限就崩"** | 冻结式压缩：到阈值把早期对话折成摘要，**切点落在 assistant 上**、摘要逐字节冻结以保住前缀缓存 |

## 功能一览

### 智能体核心（`packages/agent-runtime`）

- 回合循环、工具调用、流式输出；工具失败分类（可重试 / 权限 / 策略拒绝 / 参数错…）。
- **长程任务**：计划是一张图（步骤 + 依赖 + 失败策略）；自动续跑持续到计划没有未完成步骤，
  或撞到轮数/预算上限——不再用"连续两轮没进展"这种轮级门限替模型判断。
- **压缩与缓存**：摘要冻结、`SHE_*` 预算、tool result 按剩余余量收紧并落盘全文。
- **自省**：`reflection_check` 对照"实际目标/约束"查漂移与置信度；错题本记录并前置提示。
- **子代理**：`task_spawn` 同步或 `background: true` 即发即走；`task_status({ ids, wait: true })`
  等全部结束；并发池默认 6（`SHE_SUBAGENT_CONCURRENCY`）；子代理不能再派子代理。

### 工具面

| 组 | 工具 |
|---|---|
文件 | `fs_read` / `fs_write` / `fs_list` / `grep`（UTF-8 正确，中文不假阴性） |
命令 | `shell` / `shell_wait`（`ids` + `mode: all\|any`）/ `shell_kill` / `shell_jobs` |
版本 | `git_status` / `git_diff` / `git_log` |
地图 | `map_tree` / `map_lookup` / `map_whereis` / `map_scope` / `map_impact` / `map_wiring` / `map_contracts` / `map_verify` / `map_note` |
知识库 | `kb_query` / `kb_upsert` / `kb_link` / `kb_edit` / `kb_retire` … |
协作 | `task_spawn` / `task_status`、`plan_*`、`memo_*`、`schedule_*`、`report_write`、`skill_read` |
语言服务 | `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_diagnostics` |

### 项目地图（`packages/map`，实验功能）

- 从 `git ls-files` 建索引（路径 + 内容 sha），分片存 `.she/map/`，**一个工作区一套**；
  首次调用任何 `map_*` 自动建图；`SHE_MAP_PATH` 可指向共享目录。
- 标签绑**内容 sha**：内容一变标 `stale` 而不删（"之前什么样"留得住）。
- **接线**：`A --接线 c--> B`。覆盖 C/C++ `#include`、TypeScript/JavaScript、Python、Go、Rust、
  Ruby、Java/Kotlin、PHP；解析不到真实文件就不建边，并计入"未解析"。
- **可信度**：`map_verify` 报过期率、黑暗角落、悬空边、坏分片，以及
  `接线 N 条｜未解析 M 条`。零标签时分数封顶并明说"意图检索不可用"。
- **收编**：`map:query adopt <别的工作区>` 只写引用、不复制正文；改过的才落地并记出处。
- **局部回退**：计划 → 单次票据 → 快照 → `git restore`；脏文件与"删除型回退"默认阻断。
- 详细用法见 [`docs/project-map-manual.md`](docs/project-map-manual.md)，字段与预算见
  [`docs/project-map-schema.md`](docs/project-map-schema.md)。

### 知识库（`packages/kb`）

- **组结构 + 共振检索**，不引入 embedding：组路径本身就是检索键，边带类型与证据。
- 每轮请求末尾自动附一小段【自动召回】（结构共振排序，未必对——与当前这句无关就当没看见）。
- 节点带版本与历史：编辑保留旧版，退役保留原因与替代者。
- 可外挂共享：`SHE_KB_PATH` 指向共享库，多工作区共用一份记忆。

### 沙箱与服务（`packages/sandbox`、`packages/server`）

- 文件监狱 + 命令白名单 + 确认票据：破坏性命令要票据才执行；两层控制分别是**fail-open 的黑名单**
  与 **fail-closed 的白名单**，两者语义不同，不能互相替代。
- HTTP API：会话、设置、工具、知识、地图、审计、运行轨迹、定时任务、插件、MCP 客户端。
- 运行时状态一律经 `state-file.ts` 读写：读不出来的文件**搬走**而不是覆盖。

### 界面（`packages/ui`）

- 长对话的滚动、跟随、流式渲染；压缩记录与恢复入口；计划/时间线/地图只读面板/知识图谱白板。
- 亮/暗主题 + 自定义样式表（有逃生通道：样式把界面弄乱可以一键回退）。
- 支持拖拽调整分区；底部状态栏常驻「地图」「备忘」「计划」「时间线」等入口。

## 快速开始

```bash
pnpm install
cp .env.example .env          # 填 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
pnpm -r build
pnpm dev                      # 或 pnpm --filter @she/server start
```

Windows 也可以直接用 `SHE.bat` / `SHE-stop.bat`。桌面端打包见 [`docs/packaging-win.md`](docs/packaging-win.md)。

## 配置

关键环境变量（完整列表见 `.env.example`）：

| 变量 | 作用 |
|---|---|
`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | 主模型（OpenAI 兼容） |
`OPENAI_FALLBACK_*` | 备用提供方；主接口失败时切换 |
`SHE_WORKSPACE` | 工作区根（沙箱边界） |
`SHE_PORT` | 服务端口（默认 5577） |
`SHE_CONTEXT_WINDOW` | 上下文窗口（0 = 按模型名识别） |
`SHE_CONTEXT_AUTO_COMPACT` / `SHE_CONTEXT_COMPACT_AT` | 自动压缩开关与阈值 |
`SHE_KB_PATH` / `SHE_MAP_PATH` | 共享知识库 / 共享地图目录 |
`SHE_SUBAGENT_CONCURRENCY` | 子代理并发池（默认 6） |
`SHE_ALLOW_HISTORY_REDUCTION` | 是否允许裁剪历史（默认关闭；裁头会打掉前缀缓存） |

## 验证

```bash
pnpm check:offline     # 不需要任何 API key：构建、单测、离线评测与全部结构检查
pnpm check:all         # 追加 eval:verify（会调用模型，需要 key）
```

单项更快（`pnpm -r test`、`check:ui`、`check:toolresult`、`check:plan`、`check:delivery`、
`check:i18n`、`check:map` …）。每一项都自带 `PASS/FAIL` 与实际值，失败时不需要重跑才知道原因。

全套单项：build / suites / restart / encoding / wsl / data / security / shell / host / lock / theme / uistruct / dist / logs / a11y / i18n / toolresult / errorbook / reflection / budget / context / map / docker / api / plugins / mcp / durability / session / window / evals / retrieval。

## 仓库结构

| 路径 | 内容 |
|---|---|
`packages/agent-runtime` | 回合循环、工具注册、压缩与上下文、子代理、自省 |
`packages/server` | HTTP API、会话与设置、调度、插件、MCP 客户端、审计与轨迹 |
`packages/sandbox` | 文件监狱、shell、确认票据、工具实现 |
`packages/kb` | 知识库存储、组结构、共振检索 |
`packages/map` | 项目地图：建图、查询、接线、契约、回退安全壳 |
`packages/ui` | React 界面 |
`packages/desktop` | Electron 外壳与打包 |
`packages/shared` | 类型、配置、模型登记、环境解析 |
`scripts/` | 门禁与检查脚本（每个都有一条判据） |
`evals/` | 评测器（部分调用模型） |
`skills/` | 版本控制的默认技能（dev / liberal / general / custom / _common） |

## 文档

| 文档 | 内容 |
|---|---|
[architecture.md](architecture.md) | 设计与包布局 |
[docs/context-and-caching.md](docs/context-and-caching.md) | 上下文压缩与提示缓存（含实测读数） |
[docs/retrieval.md](docs/retrieval.md) | 结构共振检索怎么工作、边界在哪 |
[docs/project-map-manual.md](docs/project-map-manual.md) | 项目地图使用手册 |
[docs/project-map-schema.md](docs/project-map-schema.md) | 地图存储契约（字段、边、预算） |
[docs/testing.md](docs/testing.md) | 测试清单与门禁 |
[docs/plugins.md](docs/plugins.md) | 写插件：`ctx` API、权限、调试 |
[docs/custom-stylesheet.md](docs/custom-stylesheet.md) | 自定义样式与可恢复性 |
[docs/feishu-remote.md](docs/feishu-remote.md) | 手机远程控制 |
[docs/packaging-win.md](docs/packaging-win.md) | Windows 安装包 |
[SECURITY.md](SECURITY.md) | 威胁模型与实现它的守卫 |
[AGENTS.md](AGENTS.md) | 改这个仓库时的约定与坑 |
[CHANGELOG.md](CHANGELOG.md) | 变更与理由 |

## 状态

实验性但可用：地图、收编、讨论群、插件、MCP 客户端均在持续迭代；接口可能调整，
变更会写进 CHANGELOG 并带理由。已知缺口在各自文档里如实列出（例如地图的 C# 接线尚未支持）。

## 许可

见 [LICENSE](LICENSE)。
