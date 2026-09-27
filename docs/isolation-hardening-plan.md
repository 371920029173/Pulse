# 隔离根治计划

面向"正经 Agent"的标准：不变量要在**结构上不可能违反**，而不是靠提示词自律。本文是动手前的方案，未经批准不改产品代码。

状态：**层 1 / 层 2 已落地**（含门禁与真机验收），层 3 / 层 4 待做。每层落地后回填「进展」，不写"应该好了"。

---

## 进展（回填）

| 层 | 状态 | 落点 / 证据 |
|---|---|---|
| 层 1 工作区 | **已落地** | `pathKey`（真实路径 + Windows 不分大小写）、`mountStateDir()`（切换工作区时寄存离开的存储并接管缓存实例）、跨项目群存储迁移；`check:data` 第 10–12 段（第 12 段照抄真机顺序：先轮询轨道再切换，双向变异验证）；真机验收：切项目后群仍在轨道 / 能打开 / 消息落在本项目 / 知识库可用 |
| 层 2 会话 | **已落地** | 见下「层 2 落地明细」 |
| 层 3 存储 | 待做 | —— |
| 层 4 沙箱 | 待做 | —— |

### 层 2 落地明细

- **2.1 布局**：五个维度全部落在 `.she/sessions/<encodeSessionId(id)>/` 下 —— `plans.json`、`memo.json`、
  `confidence.json`、`preflight/`、`runs/`。旧数据**不迁移**（按 D3），旧的工作区级文件不再被任何代码读。
  仍然留在工作区级的三处按你当时的口径处理：`reports/`（`report_write` 的交付物）保持工作区级、
  `kb.sqlite` 本层不动、`audit.log` 保持工作区级（读取默认只当前会话，见 2.3）。
- **2.2 结构收紧**：所有 store 构造强制带会话 id（`PlanStore` / `MemoStore` / `PreflightStore` /
  `RunTraceStore` / `ConfidenceMirror`）；路径解析集中在 `sessionStateDir()`，id 非法或为空**抛错**，
  不接受空 id 兜底桶；工具层的 session id 来自 agent 上下文。跨会话的读要显式：
  `/api/runs` 默认 `scope=session`（`scope=workspace` 才跨目录）、`/api/runs/:id` 与 `/api/runs/corroborate`
  不带 `session_id` 直接 400（`explicitSessionIdOf`，**不**回退到"当前会话"）、`/api/plans/sessions` 缺
  `scope=workspace` 直接 400。
  **门禁：`pnpm check:session`**（`scripts/session-isolation-check.mjs`，63 项断言）——路径层 / 读 / 写 /
  数字账例外 / 工作区顶层反向钉子 / 真起服务六段；变异验证两个方向都做过（丢掉 `sessionStateDir` 里的
  会话 id → 转红；去掉选择器的 `scope` 门槛 → 转红），改完恢复并复跑全绿。
- **2.3 界面与说明**：`PlanPanel` 多了「其他会话」选择器 —— 打开那一刻才发那一次跨会话请求，列出的只有
  会话 id + 计数（正文一行都不带），点开后**只读**并横条说明"要改进度请回到那个会话"；
  `RunTracePanel` 的跨会话查看是显式 `scope=workspace`。口径两处已改：`system-prompt.ts` 的计划段现在
  写的是"另一份聊天里的计划在这里看不到"，且把"看不到"解释成有意为之；`ConfidenceMirror` 的拆分
  （数字账跨会话共享、话题文本只在本会话）也写进了提示词能读到的报告里。

---

## 0. 要保证的不变量

| 编号 | 不变量 | 违反的后果 |
|---|---|---|
| I1 | A 会话的记忆 / 计划 / 笔记 / 轨迹 / 推理原文，B 会话**在文件路径上取不到**；工具即使被传入别人的 session id 也必须拒绝 | 一个会话能读到另一个会话的推理原文，等于没有会话边界 |
| I2 | 一个目录 = 一种身份 = 一份存储；打开别的项目不改变当前项目的可见性（轨道不丢项、工作群不消失） | 用户看到"东西凭空消失" |
| I3 | 子进程的实际能力 ⊆ 工具参数校验的能力；做不到就用确认票 + 明示，**不许宣传"越不出去"** | 用户以为有沙箱，实际任意代码可读全盘 |
| I4 | 写入原子；损坏必须留底**并且报错**；迁移不得静默丢记录 | 一次坏写毁掉全部会话历史 |

## 1. 现状（实测事实，不是推测）

| 面 | 现状 | 位置 |
|---|---|---|
| 计划 | 按 session 过滤，但**同一份 `plans.json`** | `packages/agent-runtime/src/plan-tools.ts:723` `new PlanStore(workspaceRoot, sessionId)` |
| 备忘 | **工作区全局**，会话间完全共享 | `packages/agent-runtime/src/memo-tools.ts:89`、`packages/server/src/index.ts:4067` `new MemoStore(workspaceRoot)` |
| 运行轨迹 | **工作区全局** | `packages/agent-runtime/src/agent.ts:332` `new RunTraceStore(root)` |
| 置信度样本 | **工作区全局** | `packages/agent-runtime/src/agent.ts:421` `new ConfidenceMirror(root)` |
| 审计 | 工作区单文件，记录**带** `session_id`，查询**能**过滤；默认是否过滤取决于调用方 | `packages/server/src/audit.ts:136`、`:81`、`:323` |
| 会话 / 群存储 | 工作区级单文件；key 判定已修（见层 1） | `sessions.json`、`cluster/rooms.json` |
| 沙箱 | 只校验**命令字符串**与**工具参数**；无进程级约束 | `packages/sandbox/src/shell.ts` `SandboxShell.exec` / `validatePath` |
| 存储损坏 | `sessions.json.before-corrupt`（222,808B / **12 条会话**）仍在盘上；`sessions.json.unusable-…`（23B）是手写夹具，不是事故物证 | `D:\AGI\_she-live-test\.she\` |

对照 R14 报告的修正：③ 成立且代码可证；② 成立但**只发生在同一工作区内的会话之间**（"工作区之间"是另一条轴）；"损坏时静默清空"**不成立** —— 这版的行为是原样留底，缺的是"说出来"。

## 2. 决策点（需要拍板；括号里是我的默认）

| 编号 | 决策 | 默认 |
|---|---|---|
| D1 | 改在哪个基础：tag 新树（含今天的 `pathKey`/`mountStateDir`）还是只在 `c60c906` 重做 | 回到 tag，开分支 `isolation-root-fix`，`main` 留给 `github/main` |
| D2 | 子代理 worktree：结束即删，还是保留但登记可一键清 | 结束即删；现场证据写进 `.she/runs`（不靠工作区外的目录） |
| D3 | 会话数据迁移：就地迁移（备份 + 条数对账）还是新旧并存兼容期 | **已作废**：用户 2026-09-27 决定丢弃旧数据（对话记录/知识库都可以不要），只改路径、不迁移 |
| D4 | 审计默认读取范围：只当前会话，还是全局 | 只当前会话（全局要走显式参数） |
| D5 | 真隔离选型：WSL2 / Docker / 受限账号+ACL / 暂不做 | WSL2（见 4.2 对比） |
| D6 | worktree 目录名：保持中文（`sub-带-scope-…`）还是改 ASCII | 改 ASCII（`sub-<id>`），避免跨工具编码风险 |

## 3. 分层工作项

每项格式：**改动 → 验收 → 风险 → 回滚**。

### 层 1：工作区（最小，先落地）

- **1.1** 恢复今天的修复：`pathKey`（真实路径 + Windows 不分大小写）、`mountStateDir`（切换时寄存离开的存储并接管缓存实例）、跨项目群存储（tag 里已有）。
  验收：`check:data` 全绿（含第 10–12 段）。
- **1.2** 索引与 registry 去重（`projects.json` / `workspaces.json`）。
  验收：同一目录两种写法不再产生两行、不再产生两份存储（`check:data` 第 11 段 + 新增 API 级断言）。
- **1.3** worktree 生命周期：子级结束后清理（按 D2）；目录名 ASCII（按 D6）；新增 `/api/worktrees` 列出 + 一键删（`removeWorktree` 已有，`packages/server/src/worktrees.ts:121`）。
  验收：新增门禁 —— 一个 worktree 子级跑完后，`git worktree list` 与本机目录都不新增；异常退出也清。
  风险：误删仍在使用的 worktree → 只清"本进程创建且已结束"的，且删除前把 diff 摘要写进 `.she/runs`。
- **1.4** 清理现存残留：`D:\AGI\_she-live-test` 的注册 worktree（目录已不存在）、分支 `she/*`、索引里的 worktree 路径、归档 `sessions.json.before-corrupt`。
  风险：那是"验证 worktree 隔离"那轮的现场 → 先归档再删。

### 层 2：会话层（最大的一块，分几批推）

- **2.1 布局与旧数据**（迁移已按用户决定取消）
  目标布局：`.she/sessions/<sessionId>/{memo.json, plans.json, confidence.json, notes/, runs/, preflight.json}`
  会话目录名要经 `encodeSessionId`：会话 id 形状不止一种（聊天 `sess_<hex>`、群计划 `cluster:<roomId>`），
  而 `:` 在 Windows 上不能做目录名，所以是**编码**（可逆、不碰撞）而不是"只接受 ASCII"——后者会让群计划
  一构造就抛错（实测被门禁抓住）。
  **仍然留在工作区级的**：`reports/`（`report_write` 的交付物，和"推理原文/笔记"不是一类）、`kb.sqlite`
  （知识库按设计就是工作区的长期记忆，本层不动）、`audit.log`。这三处要不要跟着分区还没定。

  旧数据：**不迁移**。用户 2026-09-27 决定"对话记录、知识库内容什么的都可以不要"，所以不做逐条搬迁、
  不做条数对账、不写迁移脚本。旧的工作区级文件（`memo.json` / `plans.json` / `reflection/confidence.json` /
  `runs/` / `subagent-notes/` / `preflight/`）在新代码里**不再被读取**，原样留在盘上，需要时人工归档到
  `.she/archive/`。这条极大的降低了风险：层 2 从"破坏性迁移"变成"改路径 + 旧文件自然作废"。
  验收：新起的会话在自己的目录里产生状态；旧路径下的文件不再被任何代码读。
- **2.2 结构收紧（这条才是"不可能违反"）**
  - 所有 store 构造强制带会话 id：`new MemoStore(dir, id)`（现在只有目录，`memo-tools.ts:89`）
  - 工具层（`plan_*` / `memo_*` / 反思相关）的 session id **来自 agent 上下文**，不接受调用方传入
  - API 层统一走 `sessionIdOf(req)`（`index.ts:1865`）后再解析路径，禁止用裸 id 拼路径
  - 路径解析集中在 `sessionStateDir(root, sessionId)`：id 非法就抛错，不接受空 id 兜底（否则"没拿到会话"
    会静默变成一个所有会话共享的桶，正是要防的那件事）
验收：新增 `check:session`（`scripts/session-isolation-check.mjs`）—— 起真服务、两个会话，交叉断言：B 读不到 A 的备忘/计划/预检/置信度样本/轨迹；**工具被传入 A 的 id 也拒绝**；轨迹文件路径不落在 B 的目录下；工作区顶层不许再出现这些文件。
变异验证：把 id 改成入参可覆盖，门禁必须转红。
- **2.3 界面与说明**
  会话列表明示"记忆按会话隔离"；跨会话查看必须是显式动作（一个入口 + 说明），不再"看起来是一份"。

  **两个必须一并改掉的"口径"**（它们是当前行为的说明书，不改就等于文档在撒谎）：
  - `system-prompt.ts:454` 现在写着"Plans live in the workspace file `.she/plans.json`… `plan_list` returns
    every plan, including ones opened in another conversation. Switching chats does not retire them."
    —— 这正是本层要废掉的行为，提示词必须反过来写。
  - `system-prompt.ts:429` 说 `report_write` 写进 `.she/reports/`；若把报告也按会话分区，这句要跟着改。
  影响面（已核实）：`/api/memo`、`/api/plans`、`/api/runs`、`/api/reflection` 四个面板；前者是工作区全局落盘，
  后三者已按 `session_id` 过滤但**共用一份物理文件**。

### 层 3：存储

- **3.1** 原子替换：同目录写 `*.tmp` + `rename`，不再整份覆写。
- **3.2** 写前校验：`validateSessions()` 不过就 abort，保留旧文件不动。
- **3.3** 损坏：留底（已有）+ **接口/界面明确报错**（给出留底路径与丢失条数）。
  验收（门禁）：写入中途抛错 → 文件仍是旧内容；两个 store 同文件并发写不互抹；坏文件不影响启动且被点名。
  样本：`_she-live-test/.she/sessions.json`（391,498B）与 `.before-corrupt`（222,808B / 12 条）都是天然材料。

### 层 4：沙箱

- **4.1 不装依赖先做**：把"任意代码执行"（`node -e`、`python -c`、`powershell -Command`、`git -C` …）识别成独立风险等级 → 走确认票 → 结果里注明"子进程不受路径约束"；改正 `docs/s-tier-backlog.md:113` 的"路径逃逸拒绝"措辞。
- **4.2 真隔离（按 D5）**

  | 方案 | 安装代价 | 机制 | 强度 |
  |---|---|---|---|
  | WSL2（推荐） | 内核 + 发行版约 1GB；WSL 内需装 node | `wsl -d <distro> -- bash -lc '<cmd>'`，工作区挂 `/mnt/<盘>/…` | 真用户 / 命名空间隔离 |
  | Docker | Docker Desktop 1–2GB（依赖 WSL2/Hyper-V） | `docker run --rm --network=none -v ws:/ws -w /ws img sh -lc '<cmd>'` | 真隔离；冷启动 0.5–2s |
  | 受限账号 + ACL | 不用装；需原生 `CreateProcessWithLogonW`/runas + 每工作区配 ACL + 管密码 | 低权账号启动子进程 | **弱**：同机其它路径仍可能可达 |

  门禁必须**按平台可跳过**（CI 没 WSL 时 skip，不许假绿）。
- **4.3 第二条通道写进文档**：`source: cursor` 的 filesystem MCP 根由 Cursor 配置决定，所以"能碰的路径 = 工作区 ∪ 该 MCP 配置的根"，两套策略由不同组件执行 —— 产品文档要直说。

## 4. 顺序与检查点

| 步骤 | 产出 | 验收 | 状态 |
|---|---|---|---|
| 1 | 层 1 全量 | `check:data` + worktree 残留门禁 + 真机子级跑一轮 | **完成** |
| 2a | 层 2.1 迁移脚本 | 迁移对账输出 + 备份可回滚 | **作废**（按 D3：不迁移，旧数据丢弃） |
| 2b | 层 2.2 结构收紧 | `check:session` 全绿 + 变异验证转红 | **完成** |
| 2c | 层 2.3 界面 | 真机两会话交叉手测 | **完成**（选择器 + 只读横幅；真机切会话核对过） |
| 3 | 层 3 存储 | 三条存储门禁 | 待做 |
| 4a | 层 4.1 策略 + 文档 | 真机确认：任意代码执行会弹确认票且结果有明示 | 待做 |
| 4b | 层 4.2 真隔离 | 按平台门禁（可 skip）+ 真机试一条越界读取被拒 | 待做 |

每步交付：**改前改后实测对照 + 门禁结论**；不做"应该好了"的汇报。

## 5. 范围外（明确不做）

- 不属于本仓库的：Cursor 全局 MCP 配置本身（只在 4.3 写清关系）。
- 重做提示词层面的"礼貌约束"：I1 靠路径与工具层落实，不靠措辞。

## 6. 已知遗留

- R14 报告里"跨会话写（会污染他会话计划）"未测 —— 层 2.2 落地后该场景已**结构上不可达**，并由
  `check:session` 第 3 段（拿着 A 的 id 从 B 改 → 被拒且 A 的文件一个字节没变）与第 6 段
  （拿 A 的备忘 id 从 B 改 → 404）钉住，不必再手测。
- 「其他会话的计划」这条路是**显式**的（选择器 + 只读），但它列的是会话 id 与计数 —— 会话标题由界面
  从会话列表里配。若将来把标题也挪进服务端响应，注意标题同样是用户文本。
- "沙箱拦截规则穷举"（`powershell -Command` / `python -c` / `git -C`）归到 4.1 的门禁里，逐条钉住。
- `sessions.json` 是否曾轮转：从盘上看没有轮转产物（只有损坏留底），按 I4 由层 3 统一解决。
