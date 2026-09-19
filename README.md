# SHE v2 — Structured Hierarchy Engine

> 结构化层级引擎 v2：基于组结构记忆 + 脉冲种子检索的本地编程智能体
> Thin agent-runtime with Group Memory KB + PulseSeed retrieval

A local coding/assistant agent that uses a **Group Memory knowledge base** with **PulseSeed structural resonance retrieval** — not traditional vector RAG. Talks to external LLM APIs (OpenAI-compatible + Anthropic).

---

## Quick Start / 快速开始

Works on Windows, macOS and Linux. One launcher, `scripts/she.mjs`, with thin wrappers so it can be double-clicked or run from a shell.

### One-click / 一键启动

```bash
# Windows
SHE.bat              # start (desktop window, falls back to the browser)
SHE-stop.bat         # stop

# macOS / Linux
./she.sh             # start
./she.sh stop        # stop
./she.sh status      # 看运行状态
./she.sh restart     # 重启
./she.sh --browser   # 用浏览器打开而不是桌面窗口
```

The launcher checks Node and pnpm, installs dependencies only if missing, builds only
when artefacts are stale, starts the backend, waits until it actually answers, then
opens the window. It derives the project root from its own location, so any clone path
works.

Under the hood it is one command, if you prefer it explicitly:

```bash
node scripts/she.mjs <launch|stop|restart|status> [--browser]
```

**Docker / 容器**：

```bash
docker build -t she:0.2.0 .
docker run --rm -p 5577:5577 -v "$PWD/workspace:/workspace" \
  -e OPENAI_API_KEY=sk-... she:0.2.0
```

The image sets `SHE_HOST=0.0.0.0` so the port is reachable from outside the container.
See [Deployment / 部署](#deployment--部署) for binding to a LAN address or running
behind a reverse proxy.

> ### ⚠️ 这个 API 没有认证 —— 绑定地址就是安全边界
>
> 上面的 `-p 5577:5577` 会把端口发布到**宿主机所有网卡**，而不只是本机回环。这个 API 能让
> 调用者执行 shell 命令、读写工作区文件、改设置（包括打开"允许所有命令"），**它没有任何
> 认证**。也就是说，同一局域网内的任何人、同一台宿主机上的任何容器，都可以像你一样使用它。
>
> 请按你的实际场景选一种：
>
> - **只在本机用**（推荐）：`-p 127.0.0.1:5577:5577` —— 端口只对宿主机自己可见。
> - **要在局域网/手机上用**：放在反向代理后面并加认证，并设置 `SHE_ALLOWED_HOSTS`。
> - **绝对不要**把端口直接暴露到公网。
>
> 这不是"以后再加"的待办：这是当前设计（单用户本地工具）的既定取舍，所以它必须在
> 复制粘贴的路径上写清楚，而不是藏在安全文档里。

### Prerequisites / 前置条件

- Node.js ≥ 20 — https://nodejs.org
- pnpm — `npm install -g pnpm`
- Git

### 1. Clone & Install / 克隆并安装

```bash
git clone <this-repo> she-agent-cloud
cd she-agent-cloud
pnpm install
pnpm build
```

### 2. Configure API Key / 配置 API 密钥

```powershell
copy .env.example .env
notepad .env
```

Edit `.env`:
```env
SHE_LLM_PROVIDER=openai
OPENAI_API_KEY=sk-your-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
```

Any OpenAI-compatible endpoint works (OpenRouter, local Ollama, Azure, etc.) — just change `OPENAI_BASE_URL`.

> Permissions: by default the agent asks before running dangerous commands.
> `SHE_ALLOW_ALL_COMMANDS=true` lifts that entirely — see `.env.example` before
> enabling it.

### Phone remote control / 手机遥控

Drive an ongoing conversation from your phone via Feishu (Lark). No public URL,
no exposed port — the desktop dials out over a long connection.

See **[docs/feishu-remote.md](docs/feishu-remote.md)** for the 5-minute setup.

For Anthropic:
```env
SHE_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-your-key-here
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

### 3. Verify / 验证

```powershell
pnpm she doctor
```

### 4. Ingest sample data / 导入示例数据

```powershell
pnpm she kb ingest sample-workspace
```

### 5. Query the KB / 查询知识库

```powershell
pnpm she kb query "config patterns"
```

### 6. Chat / 对话

```powershell
pnpm she chat
```

### 7. Web UI / 网页界面

```powershell
pnpm dev
# Open http://127.0.0.1:5577
```

---

## Deployment / 部署

### Binding address

The server listens on `127.0.0.1` by default — reachable only from this machine.

```env
SHE_HOST=0.0.0.0        # accept connections from a container or the LAN
SHE_PORT=5577
```

### Reverse proxy / a domain

The request guard requires the `Host` header to be a name it expects. This blocks
**DNS rebinding**, where a page you visit resolves its own domain to `127.0.0.1` and
then talks to your agent as if it were same-origin.

Literal IP addresses are always accepted (rebinding needs a hostname), so LAN and
container access work with no configuration. For a domain, list it:

```env
SHE_ALLOWED_HOSTS=she.example.com,panel.lan
# or, for a proxy that rewrites Host in ways we cannot predict:
SHE_ALLOWED_HOSTS=*
```

`*` is an explicit opt-in: it accepts any Host, so only use it when the proxy is the
only way in.

Verified by `pnpm check:host` against a real server (13 cases: loopback, LAN IP,
container IP, configured domains, wildcard, and cross-origin rejection).

### Container

```bash
docker build -t she:0.2.0 .
docker run --rm -p 5577:5577 \
  -v "$PWD/workspace:/workspace" \
  -e OPENAI_API_KEY=sk-... \
  she:0.2.0
```

The workspace volume is where the agent reads and writes; state (history, KB) lives
there too. The image runs as a non-root user, and `SHE_WORKSPACE`/`SHE_STATE_DIR` both
point at the mount.

> The image has **not been built** in this development environment (no Docker
> available). `pnpm check:docker` verifies its structure — COPY paths, required
> artefacts, non-root user, health check — but that is not a substitute for
> `docker build && docker run`.

### State and data safety

Chat history, work groups and scheduled tasks are stored under `<workspace>/.she/`.
If one of those files cannot be read, it is **moved aside** (`.unusable-<timestamp>`)
and the reason is logged — never silently replaced with an empty one. Recovery is a
matter of renaming a file back.

That behaviour is a fix, not a design idea: an earlier build treated any parse failure
as "no data" and then saved that empty state over the user's conversations. See
`pnpm check:data` for the regression cases.

### Observability

`GET /api/metrics` returns process-level counters: turns (ok/failed), latency (avg and
p95), token breakdown including reasoning, tool usage with failure counts, and the
**prompt-cache hit rate**.

The cache number is the one worth watching: prompt caching is prefix-based, so a
change that alters the request prefix moves every subsequent turn from ~97% cached to
full price with no visible symptom. A long conversation sitting near 0% means
something is rewriting the prefix — see [docs/context-and-caching.md](docs/context-and-caching.md).

---


## Scope / 范围

### 已经能用的

| 面 | 现状 |
|---|---|
| Agent 运行时 | OpenAI 兼容 / Anthropic，工具循环，流式思维链，**卡住循环自动停止**，**自我验证纪律** |
| 上下文 | **压缩（冻结摘要）而非裁剪**，实测多轮会话提示缓存命中 96–97% |
| 组结构知识库 | PulseSeed 结构共振检索 + BM25 混合，有激活轨迹 |
| 工具 | 文件读写、shell、grep、git、KB 增删链、计划、备忘录、report、ask_user、知识入库、**子智能体（`task_spawn`）**、**代码智能（`lsp_*`）**、**定时任务（`schedule_*`）**、**计算机操作（`computer_*`：点击/输入/按键/滚轮，仅 Windows）** |
| 沙箱 | 工作区越界拦截（含符号链接）、破坏性命令模式拦截（fail-open）、**命令白名单（fail-closed）**、参数绑定的一次性确认票据 |
| 界面 | 桌面端（Electron，多窗口）+ 网页版；代码语法高亮、diff、工具调用行、可折叠思维链、**中文/英文切换** |
| 会话 | 多会话隔离、历史记录、关闭/删除区分、检查点撤销、消息撤回、**状态文件损坏时留底而非清空** |
| 协作 | 讨论群（多角色并行发言，角色数可配、可自定义） |
| 集成 | MCP 服务管理、插件坞（内置目录一键安装 + 脚手架 + 源码编辑）、飞书手机遥控（长连接，不开端口） |
| 自定义 | 技能档位（开发/创作/通用/自定义），技能文件可编辑，AI 可辅助生成；**自定义样式表（CSS 文件，含作用域隔离预览与锁死拦截）** |
| 部署 | **跨平台启动器（Windows / macOS / Linux）**、**容器镜像**、绑定地址与允许域名可配 |
| 可观测 | `/api/metrics`：轮次、耗时（avg/p95）、token 分类、工具使用与失败、**提示缓存命中率** |

### 还没有的（诚实清单）

| 缺什么 | 影响 |
|---|---|
| **macOS / Linux 未实机验证** | 有可移植性检查兜着，但没有在那些平台上真正跑过 |
| **容器镜像未构建过** | 本机没有 docker，只做了结构核对 |
| **界面本地化未完成** | 652 处中文文案仍硬编码；基础设施与覆盖率棘轮已就位 |
| **真实写入的 before/after diff** | 只在「待批准」阶段有 diff；直接写入时只有写入内容 |
| **embedding 对比基线** | 只能说"优于纯 BM25"，**不能说"优于向量检索"**（当前 provider 无 `/embeddings` 端点） |
| **评测规模偏小** | 检索 16 例、Agent 10 例、自我验证 5 例；单模型 |
| **样式表只能整体换肤** | 不能只改某一个面板；没有主题市场/分享机制 |
| 无障碍未全面测 | 结构性检查已通过；颜色对比度、屏幕阅读器实读、焦点顺序未验证 |
| 指标只支持拉取 | 没有推送到外部监控系统 |
| 计算机操作 | 截图与视觉描述已就位；点击/输入/按键/滚轮**仅 Windows 且需显式开启**，其他平台未验证 |

### 明确不做

- **不引入 embedding / 向量检索** —— 这是刻意的设计选择，不是待办事项。
- 不做通用 IDE。这个项目的定位是**有结构记忆的编码智能体**。

---

## 组结构 → SHE v2 对照 / Group Structure Adaptation

| 组结构概念 (AGI-3.5-v2) | SHE v2 实现 | 说明 |
|---|---|---|
| 组 (Group) | `Group` — 多叉树 + 交叉引用 | 基本组织单元，包含记忆节点和子组 |
| 记忆节点 | `MemoryNode` — text/code/fact/preference | 实用载荷，非脉冲波形 |
| 弱边 | `Edge` kind=weak | 预激活可达性提示，非相似性证明 |
| 共现边 | `Edge` kind=co_occurrence | 共同出现，无因果声明，永不提升为因果 |
| 时序边 | `Edge` kind=temporal | 时间顺序，非因果，永不提升为因果 |
| 因果候选边 | `Edge` kind=causal_candidate | 需要 evidence + falsifiers |
| 竞争子组 | `Group` isCompetitionSubgroup=true | 矛盾候选，上下文选择，不强制合并 |
| 用进废退 | accessCount + isDormant | 访问增强，长期不用→休眠→压缩 |
| 脉冲种子 | `PulseSeed` 结构共振传播 | 非嵌入相似度，可解释的激活路径 |

---

## PulseSeed Retrieval / 脉冲种子检索

PulseSeed is the retrieval primitive — **structural resonance, NOT cosine/embedding RAG**.

```
Query → Bootstrap Lookup → Create PulseSeeds → Structural Resonance Propagation → Collect & Score
         (找入口节点)      (每个种子节点)        (通过组/边传播，能量衰减)        (按激活能量排序)
```

Every result carries an **ActivationTrace**: which groups, edges, and hops caused the activation.

**Hard rules / 硬规则**:
- 弱边 ≠ 语义相似性证明 (weak edge ≠ similarity proof)
- 共现 ≠ 因果 (co-occurrence ≠ causation) — NEVER auto-promote
- 时序 ≠ 因果 (temporal ≠ causation) — NEVER auto-promote
- 因果候选边必须带 evidence + falsifiers (causal_candidate requires explicit evidence)
- 组分裂按结构均分，不用 K-means / 语义聚类 (group split by even distribution, NO clustering)
- 检索入口必须是结构共振→PulseSeed，不加关键词/嵌入回退 (retrieval MUST be structural resonance → PulseSeed)

### Does it actually help? / 实测证据

The honest answer is narrower than "it's smarter than RAG", and it's measured:

```
$ pnpm eval
用例                                     hybrid  bm25     条数(hybrid/bm25)
group-ops-env                           ✓       ✗        13/0
group-user-preferences                  ✓       ✗         8/2
group-name-only                         ✓       ✗        15/1
title-passphrase                        ✓       ✓        11/4
semantic-encoding-issue                 ✓       ✓        13/8
...
Top-1 命中    hybrid 100% (15/15)   bm25 73% (11/15)
```

**The gain comes from group-path queries, not from semantic understanding.** Look at
the count column: BM25 returns `0` for a group path, because it indexes memory text
and there is no memory text containing `ops/env`. Structural retrieval can address a
class of query that lexical search cannot address at all:

> a query about *where knowledge lives*, rather than what it says.

On the semantic cases both systems tie (100%). So the claim this project can honestly
make is **structural addressability**, not superior relevance ranking.

Caveats, stated plainly: 16 cases, one library shape, no embedding baseline. See
[`evals/retrieval/README.md`](evals/retrieval/README.md) for the full limitations list.

---

## Architecture / 架构

See [architecture.md](./architecture.md) for detailed design.

```
packages/
  shared/          ← 类型定义 (PulseSeed, Group, Edge)
  kb/              ← 组知识库引擎 (SQLite + PulseSeed)
  sandbox/         ← 沙箱 (Windows Job Object / 进程组)
  agent-runtime/   ← LLM 提供商 + 工具循环
  she-cli/         ← CLI: she chat / kb / doctor
  server/          ← REST API 服务器
  ui/              ← React 网页 UI
```

## CLI Commands / CLI 命令

| Command | Description |
|---|---|
| `pnpm she chat` | 交互式对话 Interactive chat with agent |
| `pnpm she kb ingest <path>` | 导入文件/目录 Ingest files into Group KB |
| `pnpm she kb query <text>` | PulseSeed 查询 Query KB with activation trace |
| `pnpm she kb stats` | KB 统计 Show KB statistics |
| `pnpm she doctor` | 系统检查 Check system health |
| `pnpm she server` | 启动服务器 Start API server for web UI |
| `pnpm she help` | 帮助 Show help |

## Configuration / 配置

Layered: **defaults → `config.yaml` → environment variables**

| 放什么 | 放哪里 |
|---|---|
| API 密钥、模型选择 | `.env`（不要提交） |
| 结构化设置（模型注册表、KB、沙箱、工作时间段） | `she.config.yaml` |
| 临时覆盖 | `SHE_*` 环境变量 |

```bash
cp .env.example .env
cp config.example.yaml she.config.yaml    # 可选，全部有默认值
```

**配置文件的位置**：默认在**安装根目录**（与 `.env` 同级），不是工作区目录 ——
一份安装一套配置，与工作区切换无关。放在工作区里的配置**不会有任何效果**。

需要改位置时用 `SHE_CONFIG_FILE`（容器里把配置挂在卷上、或同时维护多套配置）：

```env
SHE_CONFIG_FILE=/etc/she/config.yaml
```

配置写错会**明确报错并拒绝启动**（给出文件名与行列号），而不是静默用默认值。
未知的顶层键会打印警告 —— 拼错的设置不会有任何效果，所以必须说出来。

### 多模型 / Model registry

支持同时配置多家供应商、按用途选模型，避免被单一供应商锁定：

```yaml
llm:
  provider: openai
  model: gpt-4o
  models:
    - id: smart
      provider: anthropic
      model: claude-sonnet-4-20250514
      apiKey: ${ANTHROPIC_API_KEY}
    - id: fast
      model: deepseek-chat                       # 供应商与地址继承顶层
      baseUrl: https://api.deepseek.com
      apiKey: ${DEEPSEEK_API_KEY}
  activeModel: smart        # 主对话用哪个
  subagentModel: fast       # 子智能体用哪个（查文件、读代码这类机械活）
```

```env
SHE_MODEL=smart             # 也可以从 .env 选
SHE_SUBAGENT_MODEL=fast
```

`${VAR}` 会从环境变量展开，所以配置文件可以进版本库而不带密钥。

`subagentModel` 是最容易省下的一笔钱：子智能体做的是 `grep`/`read`/总结，
不需要主对话那个模型。id 打错时会**给出警告并回退到主模型**，而不是把错的名字
当成模型名发出去。

See `.env.example` and `config.example.yaml` for the full list.

## Tests & Checks / 测试与检查

```bash
pnpm -r test                  # 单元测试（657 项，6 个包）
pnpm eval                     # 检索评测（离线，秒级，0 API 成本）
pnpm eval:agent               # 端到端 agent 评测（调 API）
pnpm eval:verify              # 自我验证评测：会看错就答错的题（调 API）

pnpm check:data               # 数据安全：状态损坏不丢数据
pnpm check:subagent           # 子智能体接线（防递归、防越权工具）
pnpm check:security           # 本地 API 安全回归（自己启动服务）
pnpm check:shell              # Shell 引号正确性 + 命令白名单（fail-closed）
pnpm check:host               # 绑定地址 / 允许域名 / DNS rebinding 防护
pnpm check:a11y               # 无障碍：可聚焦、可键盘关闭、按钮有名称
pnpm check:lock               # 会话级轮次锁：并发请求得 409，不互相污染
pnpm check:theme              # 自定义样式：锁死拦截、逃生通道、只读文件、异常字节编码
pnpm check:uistruct           # 结构不变量：根级状态、浮层分支、注入不走 innerHTML
pnpm check:dist               # 构建产物：没有外部字体/样式引用，关键接线确实在产物里
pnpm check:portability        # 跨平台：平台专有调用是否都有分支
pnpm check:metrics            # 指标端点结构与初始状态
pnpm check:schedule           # 定时任务：顺延语义、窗口外不中断
pnpm check:lsp                # 语言服务器接线与正确性
pnpm check:i18n               # 本地化覆盖率棘轮（不允许倒退）
pnpm check:ui                 # 控件样式一致性：填充、hover、高度、死代码
pnpm check:api                # UI 调用的接口在服务端都有路由（防半个功能）
pnpm check:plugins            # 插件端到端：安装 → 智能体能调 → 卸载即失效
pnpm check:docker             # 容器镜像结构（无 docker 时的静态核对）
pnpm check:release            # 发布包头结构（含 AGENTS.md 等顶层文档）

pnpm check:all                # 以上全部 + 构建 + 单测，一次跑完
```

除 `eval:agent` 与 `eval:verify` 外**都不需要 API key、不花钱**，请务必本地跑过。

两个评测的判分都是**确定性断言**（文件系统、命令输出、回复字符串），不调用 LLM 判分 ——
那会让成本翻倍并引入不确定性。

安装验证（解压发布包 → 安装 → 构建 → 启动 → 探活）：

```bash
pnpm release                  # 跑门禁 → 构建 → 打包到 release/
pnpm release:verify           # 解压归档、真正 pnpm install、启动并探活
pnpm pack:win                 # 打 Windows 安装包；结尾自动跑 check:packaged 验证产物真能启动
pnpm check:packaged           # 只验证已打好的产物：跑解包后的服务端并探活
```

> `pack:win` 结尾会跑 `check:packaged`。**一个装完起不来的安装包不可能被打出来** —— 这条是因为
> 之前真的发生过：打包用的 `pnpm deploy` 默认是虚拟存储结构，某个包依赖写在它的**同级目录**，
> 而打包脚本把符号链接展平成实体目录后，那些依赖就找不到了。当时 `@she/shared` 还没有运行时依赖，
> 所以问题潜伏到新增一个（`yaml`）才暴露 —— 安装包启动即报 `ERR_MODULE_NOT_FOUND`。

### 当前状态

| 检查 | 结果 |
|---|---|
| 单元测试（6 个包） | 657 / 657 |
| 检索评测 vs BM25 | 100% vs 73%（+4 用例） |
| 端到端 agent 任务 | 10 / 10（按通过率判定，门槛 80%） |
| 自我验证任务 | 5 / 5（同上） |
| 数据安全 | 10 / 10 |
| 子智能体接线 | 9 / 9 |
| 安全回归 | 14 / 14 |
| Shell 引号与命令白名单 | 23 / 23 |
| 绑定地址 / 反代 / rebinding | 13 / 13 |
| 无障碍（静态） | 4 / 4 |
| 会话级轮次锁（含 409） | 10 / 10 |
| 自定义样式（锁死拦截 / 逃生通道 / 异常文件） | 73 / 73 |
| UI 结构不变量（根级状态、浮层分支、注入安全） | 22 / 22 |
| 注入回归（分隔符 / 引号 / 参数拼接） | 20 / 20（单测） |
| 硬杀重启持久化（含遗留文件迁移） | 43 / 43 |
| 非 ASCII 往返（接口 / 落盘 / 重启） | 18 / 18 |
| 日志上限与 crash.log 职责分离 | 17 / 17 |
| 构建产物接线（无外部字体、关键接线在位） | 11 / 11 |
| 跨平台静态审计 | 23 / 23 |
| 定时任务语义 | 65 / 65（两个脚本） |
| 语言服务器 | 18 / 18 |
| 控件样式一致性 | 5 / 5 |
| 容器镜像结构 | 18 / 18 |
| 指标端点 | 13 / 13 |
| 本地化棘轮 | 通过（无新增硬编码） |
| 发布包结构 | 通过 |
| 发布包可安装可运行 | 通过（实测解压 + 安装 + 构建 + 启动 + 探活） |

两个 LLM 评测按**通过率**判定而不是要求满分 —— 它们测的是模型行为，本身有波动；
随机变红的门禁等于没有门禁。真正的回归会让通过率掉下来。

`pnpm check:all` 一次跑完构建、单测、评测与全部检查脚本。

## Extending / 扩展

插件给智能体加工具，不用改 SHE 源码：

```bash
# 扩展坞 → 可安装 → 一键装；或 → 新建 → 生成可运行的骨架
```

三个官方插件在 [`plugins/`](plugins/)：`workspace-insight`（只读统计）、`env-doctor`（环境体检）、`tunnel`（隧道遥控）。

写插件的完整说明见 **[docs/plugins.md](docs/plugins.md)** —— 包括 `ctx` API、权限词表和调试方法。

### 自定义样式 / Custom stylesheet

界面整个建立在 CSS 变量上，改几个变量就能整体换肤。样式文件是一个**普通 `.css` 文件**，
可以直接用编辑器打开改：

```
~/.she-app/theme.css          ← 你的样式（Windows: C:\Users\<你>\.she-app\theme.css）
~/.she-app/theme.css.prev     ← 上一版，用于一键回退
```

也可以从 **设置 → 自定义样式…**（或 `Ctrl+K` → 「自定义样式（换肤）」）里改：左侧编辑、
右侧是**即时预览**，保存前就能看到效果。

```css
:root {
  --accent: #ff7a59;
  --radius-md: 6px;
  --font-sans: 'JetBrains Mono', monospace;
}

/* 也可以直接针对具体元素 */
aside { width: 260px; }
```

常用变量：`--bg-primary` `--bg-secondary` `--text-primary` `--text-secondary` `--accent`
`--border` `--danger` `--radius-md` `--font-sans` `--text-base` `--fill-control` `--shadow-md`。
完整清单在 `packages/ui/src/styles/global.css` 的 `:root` 里。

在 `:root` 里写的变量**深浅两套主题下都会生效**。这一点是特意做的：应用自己的深色 token 写在
`:root`（优先级 0,1,0），浅色 token 写在 `[data-theme="light"]`（0,1,1）—— 如果照搬，你的
`:root` 会赢在深色、**静默输在浅色**。所以注入时会把 `:root` / `html` 提升为
`:root, html[data-theme]`（同优先级且更靠后，两套都赢）。**磁盘上的文件保持你写的原样**，
不做改写。

**设了壁纸时哪个变量管哪块**（实测，不是推测）：

| 你想要的 | 改哪个 | 为什么 |
|---|---|---|
| 磨砂面板 / 气泡 / 弹窗的底色 | `--bg-secondary` | 磨砂规则读的就是它：`color-mix(in srgb, var(--bg-secondary) 80%, transparent)` |
| 工具调用 / 思维链区块 | `--bg-tertiary` | 同上，70% 透明 + 模糊 |
| 页面底色 | `--bg-primary` | **设了壁纸后看不见** —— 它被壁纸整个盖住了（这是设计，不是 bug） |
| 强调色 / 圆角 / 字体等 | `--accent` `--radius-*` `--font-*` | 与壁纸无关，永远生效 |

反过来说：壁纸下的毛玻璃是刻意的效果，所以它带 `!important`。要完全替换某个表面的
`background`，需要写出同样的优先级：

```css
html[data-bg="image"] [data-surface="panel"] {
  background: rgba(20, 20, 30, 0.9);
}
```

**容错**（这是这个功能的重点，因为样式表是本应用里唯一能让应用没法用的输入）：

| 情况 | 处理 |
|---|---|
| 存在会锁死界面的写法（`html { display:none }`、`* { pointer-events:none }`） | 保存前拦下，**指出具体行号和原因**；打字时就会实时提示，不用等到保存 |
| 花括号不匹配 | 拦下 —— 未闭合的规则会吃掉后面全部内容，效果和你写的完全不同 |
| 从远程 `@import` | 拦下 —— 那会泄露你这台机器在运行本应用 |
| 提示类问题（如 `url(http…)`） | 只提示，不拦 |
| 你就是想那么写 | `?force=1` 强制保存，并在返回里标记 `forced: true` |
| 预览 | **作用域隔离**：草稿只作用于预览框。`html { display:none }` 在预览里表现为"小样变白"，**弄不坏编辑器**，所以随时能改回去 |
| 界面真的被弄乱了 | 地址栏加 `?theme=off` 回车，或 `curl -X POST localhost:5577/api/theme/disable`。**两条都不依赖界面**，所以界面看不见时也能用；停用只改开关，内容保留 |
| 保存错了版本 | 「恢复上一版」（`POST /api/theme/revert`），而且这次恢复本身也能再恢复一次 |
| 误点「删除」 | 删除会留一份 `theme.css.prev`，用「恢复上一版」即可找回 |
| 样式文件只读 / 是目录 / 非 UTF-8 / 带 BOM / CRLF | 各有确定行为，**界面照常启动**，见下表 |
| 状态文件损坏 | 隔离留底并回到默认，不会导致界面起不来 |

**文件层面的异常**（样式文件是邀请用户用任何工具去改的，所以"坏"不止"语法错"一种）：

| 情况 | 行为 |
|---|---|
| 只读文件 | 保存**明确失败**，错误信息含路径与原因；原内容不动，绝不假装成功 |
| 路径上是个目录 | 同上，提示"这是一个目录，不是文件" |
| 非 UTF-8 字节（GBK 编辑器写的） | 按替换字符读取，接口不报错 |
| 开头有 BOM（记事本 / PowerShell 写的） | 读取时去掉；选择器判定走 `trim()`，而 U+FEFF 属于 ECMAScript 空白，所以也能认出 |
| CRLF 换行 | 正常解析 |
| 符号链接 | 正常，读到目标内容（dotfiles 管理器可以这么接） |
| 只有空白 | 视为空样式，不报错 |
| 并发多次保存 | 最后一次生效，不会写坏 |
| 200KB 样式表 | 校验约 30ms（编辑器每次按键都要跑） |

样式表放在应用目录（`~/.she-app`）而不是工作区里，和壁纸一致 —— 否则切工作区会**悄悄换肤**。

接口：`GET/PUT/DELETE /api/theme`、`POST /api/theme/{validate,disable,enable,revert}`。
回归检查：`pnpm check:theme`（73 项，自起服务；含"停用后内容必须还在"、"强制保存会落盘"、
"只读文件不会假装成功"、"换工作区不换肤"、"200KB 校验 <1s"）。

### 字体是本地自带的 / Fonts are vendored

界面用 **Inter** 和 **JetBrains Mono**。字体文件在 `packages/ui/public/fonts/`（4 个 woff2，
共 172KB），`@font-face` 由 `src/styles/fonts.css` 声明 —— **不连 Google**。

以前不是这样：`index.html` 引用 `fonts.googleapis.com`，每次打开界面都向 Google 发两个请求，
其中一个还是字体文件下载。改成本地自带的原因，按重要性排：

1. **它和应用自己的规则矛盾。** 样式校验器以"会泄露你这台机器在运行本应用"为由拒绝用户的远程
   `@import`，而应用自己每次启动都在做同一件事。只约束用户的规则不算规则。
2. **离线。** 这是本地优先的桌面应用，不该需要网络才能长得像自己。
3. **它不是装饰性的。** 用 `CSS.getPlatformFontsForNode` 实测：在 Windows 10 上界面文字**真的**
   由 `Inter-Bold` 渲染 —— 字体栈里的 `Segoe UI Variable` 只有 Windows 11 有，
   `-apple-system` / `SF Pro Text` 只有 macOS 有，所以 Win10 会一路落到 webfont。
   只删链接而不自带字体，会改变开发机上的实际外观。

只保留 `latin` / `latin-ext` 子集；CJK 字形本来就来自系统字体（Inter 没有 CJK 字形）。
`unicode-range` 原样保留，所以浏览器仍然只下载页面需要的子集 —— 只不过现在是向本机要。

加/改字重时跑 `pnpm vendor:fonts`（需要网络）。产物已提交，所以正常构建**不需要网络**。
`pnpm check:dist` 会断言产物里没有任何第三方字体/样式引用，防止哪天又接回去。


> **权限是声明，不是限制。** 插件与服务同进程运行，拥有完整 Node 权限，所以 manifest 里的
> `permissions` 只告诉用户它打算碰什么。这不是偷懒：真隔离需要独立进程 + IPC，
> 在此之前如实说明比做一个能被随手绕过的假沙箱更诚实。

**已知的测试缺口**（诚实记录）：

- **macOS / Linux 未实机运行过。** `check:portability` 静态审计了 160 个源文件，其中含平台分支的逐个核对，
  也验证了启动器与进程终止的分平台处理，但那些平台上一个进程都没起过。
- **容器镜像未构建过。** 本机没有 docker；`check:docker` 只核对了结构（COPY 路径、
  必要性产物、非 root、健康检查），不等于 `docker build` 能过。
- **无障碍只做了静态部分。** 可聚焦性、键盘关闭、按钮名称已检查；颜色对比度、
  屏幕阅读器实读、焦点顺序、缩放未验证。
- **界面本地化未完成**：652 处中文文案仍硬编码。基础设施已就位（`t()` 以中文原文为 key，
  缺翻译时显示中文而非裸 key），并有覆盖率棘轮防止倒退。
- **评测规模偏小**：检索 16 例、Agent 10 例、自我验证 5 例，且只用了一个模型。
- **没有 embedding 对比基线**：当前 provider 无 `/embeddings` 端点（实测 404），
  所以只能说"优于纯 BM25"。评测会明确报告这一点，而不是省掉那一列。
- **长程任务（>10 轮）仍未覆盖。**
- **计分只在单次运行上做过**：没有多次运行取方差，所以通过率的波动范围未知。

---

Apache-2.0 —— 见 [LICENSE](LICENSE)

---

## Try / Feedback / 试用反馈

If you try this build, open issues for crashes or weird imports — that helps a lot.

Sponsor the maintainer (when enabled): https://github.com/sponsors/371920029173

