# 隔离根治计划

面向"正经 Agent"的标准：不变量要在**结构上不可能违反**，而不是靠提示词自律。本文是动手前的方案，未经批准不改产品代码。

状态：**层 1 / 层 2 已落地**（含门禁与真机验收），**层 3（存储）已落地**，**层 4.0（长命令 / 后台任务）已落地**，**层 4.1（任意代码执行的策略与披露）已落地**，**层 4.2（真隔离）已落地且默认档位是 `auto`**。每层落地后回填「进展」，不写"应该好了"。

> **「已落地」= 代码、门禁、真机验收都齐了，不等于"默认已启用"。**
>
> 这两个词在这里必须分开读，否则下面的表会被误读成"隔离已经开着"。第四轮评测（11a）点的就是这一处：
> 逐层标「已落地」，而当时的运行档位是 `sandbox.isolation: 'off'`（`config.ts` 的 DEFAULTS）—— 二者可以
> 同时成立，但"代码在"和"它在拦你"是两件事。
>
> | | 是什么 | 怎么看它此刻是否生效 |
> |---|---|---|
> | **代码已落地** | 机制存在、有门禁、在真机上跑通过 | 本文每一层的「落地明细」与门禁断言 |
> | **运行档位** | 这个进程此刻**有没有**用它 | `sandbox.isolation`（`auto` 默认 / `wsl` / `off`）；未隔离时结果里**没有** `isolation` 字段（`isolationDetail()`） |
>
> **这个区分在第七轮之后只剩"解释力"，不再是一个缺口**：默认档位已从 `off` 改成 `auto` ——
> 一台机器有可用的 WSL 就用边界，没有就留在主机并在启动日志/设置接口里说明。改动的理由与代价见下
> 「层 4.2 → 默认档位」。
>
> 仍未覆盖的通道不变：**子进程与 MCP 两条通道**里，MCP 进程本身仍在 jail 之外（可从工作区派生的
> 两件事已收敛 —— 文件系统型服务的允许根、以及所有 MCP 子进程的 cwd）。这是**已记录的能力缺口**，
> 不是"应该已经拦住了"。

---

## 进展（回填）

| 层 | 状态 | 落点 / 证据 |
|---|---|---|
| 层 1 工作区 | **已落地** | `pathKey`（真实路径 + Windows 不分大小写）、`mountStateDir()`（切换工作区时寄存离开的存储并接管缓存实例）、跨项目群存储迁移；`check:data` 第 10–12 段（第 12 段照抄真机顺序：先轮询轨道再切换，双向变异验证）；真机验收：切项目后群仍在轨道 / 能打开 / 消息落在本项目 / 知识库可用 |
| 层 1 工作区围墙 | **已收成一份**（第七轮） | 见下「工作区围墙：四份实现收成一份」 |
| 层 2 会话 | **已落地** | 见下「层 2 落地明细」 |
| 层 3 存储 | **已落地** | 见下「层 3 落地明细」；`check:data` 第 13 段（健康项目不谎报 / 损坏时接口报出真实备份 / 服务自己写的形状能原样读回） |
| 层 4 沙箱 | **已落地**（4.0 长命令 / 后台任务 + 4.1 任意代码执行的披露 + 4.2 真隔离 + 4.3 shell 方言） | 见下「层 4.0 落地明细」「层 4.1 落地明细」「层 4.2 落地明细」「层 4.3 落地明细」 |

### 工作区围墙：四份实现收成一份（第七轮）

**问题（第七轮实测）**：工作区越界判定原来有**四份**拷贝（`sandbox/shell.ts` 的
`resolveInsideWorkspace`、`server/index.ts` 的 `jailToWorkspace`、`server/files.ts` 的 `jailPath`、
`agent-runtime/lsp-tools.ts` 的 `resolveInWorkspace`），前三份各自跟着软链接复查，**第四份只做了
文本判定**（`join` + `relative`）。于是同一个夹具在两处得到相反结论：

```
工作区里放一个指向 %TEMP% 的链接
  fs_read          → Path escapes workspace via link
  lsp_diagnostics  → 把工作区外那 64 行读出来，给了诊断（1:14 [2322]）
```

这不是"某一处写错了"，是同一件事有四个答案 —— `files.ts` 里原本就写着这句话：
"A second copy of this logic is how a jail quietly develops a hole in one place only."

**做法**：判定收进 `@she/shared` 的 `workspace-path.ts` 一份（`resolveWorkspacePath` + `isInsideDir`），
四个调用方都改为调用它。两处出口是刻意的：`jailWorkspacePath` 给**文本**形态（调用方要原样回显
用户写的路径），`realPathInWorkspace` 给**真实**形态（要打开文件时用）。谁自己再算一遍
`realpath`，谁就又有第二个答案。

**顺手发现的老坑（四份都有，只是没人测过）**：回退逻辑原来只回退**一层**父目录去展开软链接。
父目录**也不存在**时回退也失败，`real` 停在 `os.tmpdir()` 给的 8.3 短名（`LONGUS~1`）上，而
`realRoot` 已经是长名 —— 同一个目录被判成"逃逸"，**拒绝的是工作区里面的路径**。现在沿祖先一路
向上找到第一个存在的目录再展开（缺失的段不可能含链接，所以这不削弱检查）。这条是收成一份之后
补用例才暴露的。

**门禁**：`check:lsp` 末段「软链接越界（LSP 与 fs 必须同答）」把**同一个夹具同时喂给两条通道**，
断言判定相同、且两侧的拒绝都点名"链接"（两种情况要改的东西不一样）；反向断言区内真文件两侧都
放行，免得这一节靠"见谁都拒"变绿。
单测：`packages/shared/src/workspace-path.test.ts`（12 项，那一份实现自己）、
`packages/agent-runtime/src/__tests__/lsp-jail.test.ts`（5 项，走 `executeLspTool` 工具入口，
证明拒绝发生在**读文件之前**）。

**变异验证**：把软链接复查的"拒绝"抽掉（不删代码 —— 删了 `realRoot`/`real` 会因未使用而
`tsc` 先拒绝编译，第一版变异脚本把这种"没编译成功"误报成了"变异存活"）→ **两条通道同时转红**
（`check:lsp` 4 条 + `lsp-jail.test.ts` 2 条 + `workspace-path.test.ts` 4 条）。恢复后全绿。

**留着的口子（已披露，未收窄）**：`lsp_hover` 只做**输入**侧的围墙，不做**输出**侧的遮盖。光标停在
工作区外声明的符号上时，它照样打出那个声明的类型签名与文档注释，字符串常量连字面值一起给。
这是语言服务器本来的行为（库类型、`lib.d.ts` 全靠它），硬拦会让所有库类型的 hover 变空，所以
**照答 + 在代码里写明**（`lsp-tools.ts` 里 `lsp_hover` 的定义旁有一段"没被围墙盖住的一格"）。
对照：definition / references **返回的位置**是遮过的，只给 `[工作区外] <文件名>`（`locationLabel`）。
收窄与否留给使用者定，默认不动。

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
  **门禁：`pnpm check:session`**（`scripts/session-isolation-check.mjs`，93 项断言）——路径层 / 读 / 写 /
数字账例外 / 工作区顶层反向钉子 / 真起服务六段；另有三段钉**工作区边界**本身：会话栈只列当前工作区、
「建了就要看得见」（创建与列表落在同一个 store）、以及临时工作区不写进 `.env` 当默认（见下面 2.4）。
变异验证两个方向都做过（丢掉 `sessionStateDir` 里的会话 id → 转红；去掉选择器的 `scope` 门槛 → 转红；
把 `isScratchWorkspace` 短路成 `false` → 第 9 节转红），改完恢复并复跑全绿。
- **2.3 界面与说明**：`PlanPanel` 多了「其他会话」选择器 —— 打开那一刻才发那一次跨会话请求，列出的只有
  会话 id + 计数（正文一行都不带），点开后**只读**并横条说明"要改进度请回到那个会话"；
  `RunTracePanel` 的跨会话查看是显式 `scope=workspace`。口径两处已改：`system-prompt.ts` 的计划段现在
  写的是"另一份聊天里的计划在这里看不到"，且把"看不到"解释成有意为之；`ConfidenceMirror` 的拆分
  （数字账跨会话共享、话题文本只在本会话）也写进了提示词能读到的报告里。
- **2.4 工作区边界（2026-10-01 补）**：前三节的隔离都是**会话之间**的；真机上"隔离无效"的观感其实来自
  **工作区之间**的两处漏，各补了一节门禁：
  - `/api/conversations` 曾遍历所有被记住的项目合并成一条列表 → 任何工作区打开都看得见别人的对话
    （第 7 节，含"全新空工作区里一条都没有"这条反向钉子，同时钉住 `recoverLegacyState` 不再从安装根
    搬会话进来）；
  - `POST /api/sessions` 与 `GET /api/conversations` 曾在 `SHE_STATE_DIR ≠ workspace` 时读写的不是同一份
    store —— 建了会话、单条也读得到、列表里永远没有（第 8 节）；
  - 界面侧：会话栈只在**当前工作区**里找得到自己的历史，所以历史面板补了「包含其他工作区」这个显式
    开关（默认关），否则"切了工作区"和"对话被删了"在用户看来是同一件事。侧栏常驻显示当前工作区名，
    因为此前进了工作区就再也看不到自己在哪个项目里。
- **2.5 临时目录不当默认工作区（2026-10-01 补）**：`mountWorkspace` 会把 `SHE_WORKSPACE` 写进安装目录
  **真正的 `.env`**（"下次启动回到上次的项目"）。对项目是对的，对测试目录是错的：被指过去一次，此后
  每次启动都从那里开始，而界面上没有任何东西说明这件事 —— 真机上就是这么"丢失"了用户的项目的。
  现在 `packages/server/src/scratch-workspace.ts` 里的 `isScratchWorkspace()` 判定两类位置（系统 temp 之内、
  或本仓库夹具的命名约定如 `_she-*` / `_e2e_*`），**切换照常生效，只是不写进 `.env`**；普通项目照旧记住。
  第 9 节正反两条都钉（临时目录不改动那一行、普通目录必须写下），单测
  `scratch-workspace.test.ts` 钉判定本身（含"用户自己的 `my-tests/` 仍是项目"这类反向用例）。

### 层 4.0 落地明细（长命令 / 后台任务）

这一项不在原计划的 4.1–4.2 里，是动手时先撞上的能力缺口 —— 它属于层 4（沙箱），所以记在这里而不是第四层之外。

- **缺口**：沙箱只能跑「30 秒内结束」的命令，且没有 `timeout_ms`、没有后台。意味着构建、测试套件、训练、
  起服务这些**正经 Agent 的日常**根本跑不了；而失败长成 `timedOut`，读起来像"这条命令太慢"，不像
  "这个能力不存在"。前台的答案只有一种：杀掉进程。
- **4.0.1 作业注册表**：`SandboxShell` 里一个 `jobs` 表，前台与后台共用同一个 `Proc`（前台就是"暂时还没有
  名字的那个"）。`timeout_ms` 到点不再杀，而是**登记成 `job_N` 并把调用提前答回**——进程不碰、输出不丢。
  `shell_wait`（阻塞到结束 / 到 pattern / 到 `wait_ms`）、`shell_kill`、`shell_jobs` 三个工具补齐；
  读是**增量**的（读过的字节不再发第二遍），滚动尾部单独留一份给 pattern 匹配（滚过去的行也能命中）。
- **4.0.2 策略同一条路**：后台走的是与前台同一个 `admit()`，白名单 / 黑名单 / 确认票一个都不少；被拒时
  **不先起进程**。`check:background` 第 6 段钉住"后台不是绕过策略的路径"（含 `DENIED` 只出现一次）。
- **4.0.3 收尾（这一节的真正难点）**：进程树是三层 —— `powershell.exe → cmd.exe → 真实命令`。
  `taskkill /T /F` 会**先取一次后代快照再杀**，快照期间新建的进程不在里面，于是活下来成为孤儿：
  父进程已死、`shell_jobs` 看不见、却握着输出管道（父进程因此退不掉）和工作目录（于是删目录 EBUSY）。
  实测代价：一次全绿的测试文件留下 5 对孤儿，临时目录删不掉。修法是杀完再**复核一遍后代并逐个补杀**：
  Windows 记录的是进程**创建时**的父 id，父死也不改写这条链，所以回着走仍然能找回 `/T` 漏掉的那些。
  `dispose()` 不再自己短写一遍，而是交给 `stopAll()`，避免两条路再次漂移。
- **4.0.4 复核一遍不够（第二次实测才看出来的）**：上面那条"杀完复核一遍"是**单趟**的，而它与 `/T`
  漏杀是**同一个竞态** —— 复核自己也要读一次进程表，读表期间新建的进程照样漏。八个作业一起停，
  16 个进程里留下 1 个 `node.exe`，正是这个尾巴。改成**收敛**：复核到"连续两趟都查无遗留"才算干净。
  两趟而不是一趟，因为**"查无遗留"这一趟恰恰就是会漏掉新来者的那一趟**；有界（6 趟）是因为
  一个永远在 fork 的命令不能把收尾变成死循环。
- **4.0.5 三处"看着没问题、实际会漏"的读法**（都是真机考出来的，不是推的）：
  - **读不到进程表 ≠ 没有后代**。`wmic` 失败时返回空串，解析出 0 行，于是复核宣布"干净"并停止 ——
    实测就是这样对着一个还在跑的孤儿连报两趟"没有遗留"。现在读表失败返回 `null`（与空表分开），
    解析出的行数少得不像一台在跑的 Windows 也当读失败，复核遇到它只重试、不当作安静。
  - **等错了事件**。确认"杀掉了"等的是 `close`（管道关闭），而活着的孙进程握着管道写端，于是
    `close` 可以很晚甚至永远不来：实测根进程早就死了，`shell_kill` 却卡了 5.4 秒。改等 `exit`
    （进程本身退出），`close` 仍用于"输出读完了"。
  - **杀前那次快照才是唯一完整的一次**。等 `/T` 把中间层收掉之后，链就落在死 pid 上再也走不通了，
    所以杀之前先把整棵树记下来（`known`），复核用它来认领"链断在某个已回收祖先上"的进程。
    这是有极限的：**整条链都在第一趟之前被回收**的进程认不回来，门禁里把这条极限也钉住了。
    顺带一个可复现的坑：想造"中间层被回收、孙进程还活着"这个状态，孙进程必须 `detached` ——
    否则杀掉中间层时 Windows 会连着销毁它的控制台，把孙进程一起带走（这也是 `spawnCommand`
    在 Windows 上**不能** detach 的另一面）。
- **门禁：`pnpm check:background`**（`scripts/background-check.mjs`）—— 真进程、真等待、真数进程表：
  跑过原来的 30 秒墙、pattern 命中即返回、停掉后**机器上没有残留**、孙进程不孤儿、前台超时是转后台而非杀掉、
  被终止的任务不带退出码（否则会被读成"命令跑失败了"）。
  **变异验证**：去掉复核那一段 → 门禁转红并点名 `剩余 2`；恢复后复跑全绿。
  一份"只要 kill 报出已终止就算过"的检查在带 bug 的构建下**照样全绿**（第一版就是这样过的），所以这里
  断言的是进程表，不是工具的答复。
  收尾的三个**失败态**各自成段、各自可变异：中间层被回收（去掉杀前快照 → 孙进程认不回来就转红）、
  进程表读不到（把 `null` 当空表 → 对着还在跑的孤儿报"干净"就转红）、一次停 8 个（去掉收敛就转红）。
  在 Windows 上它还额外钉住：进程刚起来时工具返回 ≠ 命令已在跑（要等进程表上真的出现），
  以及删临时目录前必须等进程真的死掉（否则 EBUSY 会把一次全绿变成失败）。
  这一次的教训是**竞态检查要连跑几遍**：单趟复核、收敛版、收敛 + 读表失败版都曾在第一次跑就全绿，
  而八作业并发那一遍才把它按下去 —— 所以这类门禁的验收标准是"连跑三遍全绿"，不是"跑过一次"。

### 层 4.1 落地明细（任意代码执行的策略与披露）

- **缺口**：工作区边界是按**命令文本**判的 —— 看得见的路径会被 `resolveInsideWorkspace` 拒掉
  （`cd C:\`、`> ..\file`、`node C:\evil.js`，都有测试）。但程序写在命令行里时，路径在字符串内部，
  文本扫描看不见。这不是猜的，是量的：`check:shell` 第 6 段和 `code-exec.test.ts` 各钉了一条
  `node -e "require('fs').writeFileSync('<工作区外>/x','1')"` —— **放行，且 `workspaceEscapeReason` 返回 null**。
  `-EncodedCommand` 更彻底：base64 就是为了让人读不了。
- **为什么不做成确认票（原计划写的是"走确认票"，实际改成披露）**：读代码字符串意味着为每一种语言各写一个解析器
  （然后是 base64、再然后是 `eval(require('buffer')...)`），而 `node script.js` 在同一个工作区里是**同样的权力**：
  拦 `-e` 只教会人把代码挪进文件。拦不住的那一半硬拦，得到的是"看起来拦住了"。
  所以这里的取舍是明确的：**命令照跑，事实照说**。
- **4.1.1 识别**（`shell.ts` 的 `INLINE_CODE_INTERPRETERS` + `detectInlineCodeExecution`）：node（`-e`/`--eval`/`-p`/`--print`）、
  python/py（`-c`）、powershell/pwsh（`-Command`/`-c`/`-EncodedCommand`）、cmd（`/c`/`/k`）、
  sh/bash/zsh/dash/ksh/fish（`-c`）、perl/ruby/lua/luajit/Rscript（`-e`）、php（`-r`）、deno（`eval`）、bun（`-e`）。
  两个易错处都钉住了：**按段判**（`echo ok && node -e "…"` 要认得，`echo "node -e x"` 不能误报）、
  **认解释器名字而不是任意出现**（`git -c core.x=y`、`ls -c` 不误报）。
- **4.1.2 披露**（`codeExecutionDisclosure` + 三条渲染路径）：结果由 `admit()` 在**唯一那个所有命令都要过的点**打标，
  存到 `Proc` 上，因此前台结果、`background:true` 的启动回执、以及之后每一次 `shell_wait` 都带着它 ——
  一次性的披露等于没披露（模型早翻页了）。文案说三件事：命令**跑了**、这个子进程**不受工作区边界约束**、
  真隔离是层 4.2；并且被拒的命令**不**带这句（它没有子进程）。
- **4.1.3 提示词与文档口径**：`system-prompt.ts` 的 Workspace 段从"All file operations are sandboxed…Path escapes are blocked"
  改成明说"边界是**对命令文本**的，不是对进程的"，并要求如实说出命令可能碰到什么；
  `SECURITY.md` 的工作区逃逸一行加了"看得见的"，并在"你需要自己承担的边界"里新增一条；
  `docs/s-tier-backlog.md:115` 的"路径逃逸拒绝"按原计划改正。
- **门禁**：`check:shell` 新增第 6 段（16 条形式逐条钉住 + 越界代码字符串那条"缺口"断言 + 4 条不误报 +
  真跑一条 `node -e` 并检查回执里真的有披露 + 被拒命令不带披露）；单测 `code-exec.test.ts`（52 项，含后台任务三个时点）。
  **变异验证三向**：去掉渲染层披露 → 转红；对所有命令都打标（过度识别）→ 转红；
  不做分段（只报第一段）→ 转红。另外**直接改 `dist/tools.js` 再跑门禁**也转红，证明它读的是构建产物。

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
| 存储损坏 | `sessions.json.before-corrupt`（222,808B / **12 条会话**）仍在盘上；`sessions.json.unusable-…`（23B）是手写夹具，不是事故物证 | `<projects-root>\_she-scratch\.she\` |

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
- **1.4** 清理现存残留：`<projects-root>\_she-scratch` 的注册 worktree（目录已不存在）、分支 `she/*`、索引里的 worktree 路径、归档 `sessions.json.before-corrupt`。
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
  样本：`_she-scratch/.she/sessions.json`（391,498B）与 `.before-corrupt`（222,808B / 12 条）都是天然材料。

### 层 3 落地明细

- **3.1 原子替换**：`saveStateFile` 先写同目录的 `${path}.${pid}.${seq}.tmp` 再 `rename` 覆盖目标。
  临时名带**每次调用递增的序号**，不是只有 pid —— 两个 store 开在同一个路径上时 pid 相同，只按 pid
  命名会让它们互相把对方写了一半的字节改名就位（这正是「切换工作区时旧实例还在写」的形状）。
  写失败时**自己清掉那个 .tmp**：一个留在真文件旁边的 `sessions.json.<pid>.tmp` 在任何人眼里都是一份
  状态，下一个读者还得猜哪个是活的。
- **3.2 写前校验**：`StateFileSpec` 新增 `validate`，`saveStateFile` 在**碰盘之前**先跑它。
  `assertWritableSessions` / `assertWritableRooms` 拒绝的是「加载器会静默丢掉」的那些形状：某条记录不是对象、
  没有 id、id 重复、`messages`/`members`/`roles` 不是数组（会被换成空）、`title` 不是字符串、`active_id`
  指向不存在的会话。抛出去就 abort，**盘上那份一个字节不动**。
  为什么要单写一套校验而不是复用加载器：加载器是**故意宽容**的（丢坏条目、把缺的数组补成 `[]`），
  这样读别人写的旧文件还能把数据还给用户；把同样的宽容用在**自己写**的这一侧，就变成了静默永久丢数据 ——
  一条会被加载器丢掉的记录，下一次启动就没了，而盘上的文件全程看起来是健康的。
- **3.3 损坏：从"只写日志"改成"说出来"**。留底本来就有（`.unusable-<时间戳>`），但用户看不到 ——
  界面只是少了几条会话，和应用把聊天记录删了长得一模一样，差别只在日志里。
  现在 `recovery`（留底路径 + 原因）跟着 `/api/sessions`、`/api/cluster/rooms`、`/api/conversations`
  三个接口一起返回，UI 用 `StateRecoveryNotice` 常驻横幅显示，路径可复制、可关掉。这是「应用丢了
  我的聊天」和「应用保住了我的聊天，文件在这儿」的区别。
- **验收**：`check:data` 第 13 段钉住三件事 —— 健康项目**不谎报**（常驻假警告会让真警告失效）；
  文件损坏时接口报出的**备份路径真实存在、内容就是原文**（指路必须能照着走，否则提示只会让人更着急）；
  服务自己刚写下的 `sessions.json` 是「能原样读回」的形状（顺带看住"加载器将来变宽容"这条路）。
  单测另有：`saveStateFile` 校验失败时旧文件逐字节不变（两个 store 同文件并发写不互抹）、
  两个 assert 各自的拒绝面、以及 `StateRecoveryNotice` 的渲染/关闭/空态。
- **顺带（存储邻域）**：临时工作区堆积。实测系统临时目录里 **10429 个 `she-*` 目录 / 566 MB**，
  主力是几个单测文件每次用例都 `mkdtempSync` 一个新工作区却从不删除（`run-trace` 一个文件 5264 个、
  kb 3061 个、反思 1019 个、命令注入 553 个、lsp 四个文件各 65 个）。**已在源头修掉**（各自把自己建的
  删掉，验证方式是跑完三个套件后目录总数一个不涨），并补了一个有边界的清扫 `check:temp` 去清掉以前
  各轮已经漏下来的：只在系统临时目录里、只删目录、只删 `she-` 前缀、只删一天以上没动过的，带自测
  （够旧的删、刚建的留、别家的留、同名文件留；阈值收到 0 时刚建的也该被清，以证明它真的在看年龄），
  自测失败会让门禁变红，**真正的清理永远不让门禁变红**。
  同一个根因在 LSP 客户端里也咬了一口：`LspServer.stop()` 先 `disposed = true` 再发 `shutdown`/`exit`，
  而 `rawRequest`/`notify` 都会在 `disposed` 时直接返回 —— 于是**握手从来没发出去过**（两个 try/catch
  把证据吃了），而且它不等待进程真的退出（`proc.killed` 只说明信号发出去了）。结果是语言服务器可以
  比应用活得久，而且那些临时目录永远删不掉。现在：握手在 `disposed` 之前发（有超时）、等 `exit`
  再返回、等不到才 `kill`。
- **顺带（门禁可信度）**：清理失败不能让一个全过的文件变红。三处测试钩子（两个 sandbox 文件、
  `mcp-bridge.test.ts`）在 `stopAll()`/`shutdown()` 之后裸调 `rm`，而"停掉"不等于"进程已经松开目录" ——
  2026-09-29 门禁在本机跑着一个无关的训练任务时撞上，报成 `hookFailed: EBUSY`，断言全过。
  这正是「重跑到绿」的养成器，所以那三处改成重试 + 报告（不抛）。留下的目录由 `check:temp` 收。
  规则本身写在 `scripts/lib/temp.mjs` 的文件头，并注明包内测试钩子用不上那个模块，得自己重试 + 报告。

### 层 4：沙箱

- **4.1 不装依赖先做**：把"任意代码执行"（`node -e`、`python -c`、`powershell -Command`、`sh -c`、`-EncodedCommand` …）识别成独立风险等级，**结果里注明"子进程不受路径约束"**；改正 `docs/s-tier-backlog.md` 的"路径逃逸拒绝"措辞。
  **已落地**（明细见上）。与原计划的一处偏差：**没有走确认票**。读代码字符串要为每种语言写解析器（然后是 base64），
  而 `node script.js` 在同一个工作区里是同样的权力 —— 拦 `-e` 只教会人把代码挪进文件，得到的是"看起来拦住了"。
  所以取舍是**命令照跑、事实照说**；真隔离归 4.2。
- **4.3 方言透明**（第四轮 3a / 3b）：命令**按哪个 shell 的语法跑**要说在前面，写错了要说清楚。

  3a 的实测形状是"最难被发现的一类失败"：`echo $HOME` 在 cmd.exe 下**退出码 0**、打印字面 `$HOME`；
  `'a b.txt'` 被拆成两个参数；`$(date)` 不展开；`~/x` 指向名为 `~` 的目录。没有错误、没有拒绝，
  输出看着像回事 —— 与层 4.1 的 `node -e` 同一个取舍：**不拒绝，如实说**（拒绝会让普通命令变得难写，
  而且这些写法本身有字面含义）。

  两半都要有，缺一半都还漏：只把 shell 名写进描述（3b）仍会写错且错了没人提；只在出错时报（3a）
  则每次都要先白跑一条命令。**已落地**（明细见下）。
- **4.2 真隔离（按 D5）**

  | 方案 | 安装代价 | 机制 | 强度 |
  |---|---|---|---|
  | WSL2（推荐，**已落地**） | 内核 + 发行版约 1GB；WSL 内需装 node（实测 `apt` 装 node 22 约 70 秒） | `unshare -m` 私有挂载命名空间：工作区 bind 到 `/ws`，`/mnt` 用 tmpfs 整体遮盖 | 真隔离（Windows 侧只可见工作区） |
  | Docker | Docker Desktop 1–2GB（依赖 WSL2/Hyper-V） | `docker run --rm --network=none -v ws:/ws -w /ws img sh -lc '<cmd>'` | 真隔离；冷启动 0.5–2s |
  | 受限账号 + ACL | 不用装；需原生 `CreateProcessWithLogonW`/runas + 每工作区配 ACL + 管密码 | 低权账号启动子进程 | **弱**：同机其它路径仍可能可达 |

  > **原计划这一格写错了，实测更正。** 原表格把 `wsl -d <distro> -- bash -lc '<cmd>'`（工作区挂
  > `/mnt/<盘>/…`）当成 WSL2 的机制。**那本身不是隔离**：WSL 默认自动挂载整个盘，所以这条命令能读到
  > 工作区旁边的任何文件。实测：无隔离时越界文件 `outside-readable=YES`。
  > 真正起作用的是私有挂载命名空间 + tmpfs 遮盖，实测同一文件 `outside-readable=NO`、`/mnt` 里没有任何盘符、
  > 而 `node` 照常可用（它在 `/usr/bin/node`，不在 `/mnt` 下）。

  门禁必须**按平台可跳过**（CI 没 WSL 时 skip，不许假绿）。
- **4.3 第二条通道写进文档**：`source: cursor` 的 filesystem MCP 根由 Cursor 配置决定，所以"能碰的路径 = 工作区 ∪ 该 MCP 配置的根"，两套策略由不同组件执行 —— 产品文档要直说。
  **2026-10-02 更新**：前半句已经不成立 —— 允许根改由工作区派生（`confineMcpRoots`），子进程 cwd 也钉在工作区（`confineMcpServer`），所以"能碰的路径"不再包含 MCP 配置里写的那些根，收敛掉的原值在面板的 `confinedRoots` 里。剩下真正要说清的是"**进程**仍在 jail 之外"（`SECURITY.md` 已按这个口径改写）。

### 层 4.2 落地明细

**代码**：`packages/sandbox/src/isolation.ts`（新）+ `shell.ts` 的 `spawnCommand` / `admit` 接线，配置项
`sandbox.isolation`（`auto` 默认 / `wsl` / `off`）与 `SHE_SANDBOX_ISOLATION`、`SHE_WSL_DISTRO`。

**边界长什么样**（脚本与理由都在 `buildConfinedScript` 的注释里，这里只记结论）：

1. 外层先记下当前挂载命名空间 id，再 `unshare -m --propagation private`；
2. 内层**自检**命名空间 id 与记下的不同，否则以 91 退出，**不许**继续盖 `/mnt`；
3. 工作区 bind 到 `/ws`，`/mnt` 用一次 tmpfs 整体遮盖（遮盖前先把 `/etc/resolv.conf` 的内容读出来，盖住后写到 `/mnt/wsl/resolv.conf` —— WSL 把它链在 `/mnt` 下，不写回就解析不了域名，边界内 `/mnt` 也只剩这一项）；
4. `cd /ws<相对 cwd>` 后 `exec bash -lc`，退出码原样传出。

命令与路径一律 base64 传递 —— 命令是任意文本，拼进 shell 就是这一层要拦的注入。

**不覆盖什么**（跟着结果一起披露，不让读者自己猜）：发行版内部的文件系统（Linux 侧是 root）、网络出站、
以及经 WSL 互操作启动的 Windows 程序。披露写在 `isolationDetail()`，与机制放在一起，防止说明和实现各说各话。

**策略**：`off` 完全不动（宿主行为逐字节不变）；`wsl` 是明确要求，**要不到就拒绝**（绝不为"没装 WSL"静默降级到宿主，
那会让结果里的"已隔离"变成假话）；`auto` 是有偏好，取不到就走宿主，此时结果里**没有** `isolation` 字段即表示没隔离。

**默认档位：`off` → `auto`（第七轮）**

**为什么改**：机制可用、门禁全过、真机验过，而默认关着 —— 第七轮评测把这一条点成距 S 的**主要差距**，
原话是「机制可用且验证过，默认关着」。一个没人打开的边界等于不存在的边界。`auto` 是正确的默认档位，
因为它在**给不出边界的时候自己说**：退回主机，并在启动日志与 `/api/settings` 里说明原因（`isolationNotice`），
而不是拒绝执行。所以这次改动不是"强加边界"，而是"有边界的地方就用它"；`wsl` 继续留给"宁可失败也不
在无边界下跑"的调用方。

**代价（实测，不是推测）**：边界里命令是**Linux 进程**，`powershell` / `cmd` / `taskkill` / 盘符路径都用不了，
工作区是唯一可见的 Windows 路径。这条代价不是理论上的 —— 门禁自己先撞上了：`check:toolresult` 有一条
「`cmd /c echo hi` 成功 → 分类 `none`」的用例，改成 `auto` 之后那条命令进了命名空间，bash 答
`cmd: command not found`、退出码 127，于是被分类成 `nonzero_exit`。**它红得对**：那条断言量的东西
跟它的名字不是一回事了。要 Windows 工具的工作流写 `SHE_SANDBOX_ISOLATION=off`（`.env.example` 里
三个档位与这个取舍都写明了）。

**同一批修掉的两件事**（否则这个默认档位是假的或有代价的）：

1. **描述与事实不一致**：`shellName()` / `dialect()` 原来读的是 `config.isolation !== 'off'`，也就是
   "用户要的是什么"，而不是 `planIsolation()` 解析出的"会发生什么"。两者只在一格上分叉，而那一格正是
   `auto` 的主场：机器用不了时 `planIsolation` 返回 null、命令在主机上由 `cmd.exe` 解析，描述却说
   「bash -lc（WSL 隔离内）」、`dialect()` 报 `posix` —— 于是 4.3 那套 cmd 方言差异**一条都不报**。
   方向是错的：`auto` 会降级掉一个**已记录**的能力缺口，却新增一个**未记录**的方言缺口。现在两者都问
   `planIsolation`，并且 `check:sandbox-isolation` 新增一段「描述与事实」，对 `off` / `auto`（无法映射的
   工作区根）/ `wsl` 三格断言「声称在哪跑 == 实际在哪跑」，另加一条 `dialect()` 与 `shellName()` 必须
   自洽。变异验证：把 `shellName()` 改回读 `config.isolation` → 三格全红；改回来就绿。
2. **门禁不再随机器变**：默认档位一改，检查脚本里 `new SandboxShell(dir, cfg.sandbox)` 这种写法就在
   有 WSL 的机器上进命名空间、在没 WSL 的机器上留在主机 —— 同一条断言量到两件事。新增
   `scripts/lib/host-sandbox.mjs`（`pinHostSandbox()` 钉 `off`，最后一个位置展开所以盖得住调用方带来的档位），
   15 处调用点全部改为钉死；`check:preflight` 的「门禁脚本的环境卫生」一节跑它的自测并断言仓库里没有
   未钉档位的沙箱。**变异证据就是修之前的那次运行**：守卫一次点名了全部 15 处（`budget-check.mjs:84`、
   `tool-result-check.mjs:56/67/135/203`、`evals/*` 等）。

**落地过程中撞到并修掉的三件事**（都不是"设计如此"，是被门禁和实测逼出来的）：

1. **第一版根本没进命名空间**：`mount -t tmpfs none /mnt` 直接跑在**共享**命名空间里，把整个发行版的盘符
   全遮了。症状出现在下一条命令（`exit 90` 工作区不可见），原因却在别处。修法就是上面那两条自检——
   失败模式从"机器被改"变成"命令不跑"。（事后确认 `wsl -e` 每次调用自带命名空间，未留下残留挂载。）
2. **`check:wsl` 的 node 探测被 `wsl --` 吞掉命令替换**：`n=$(command -v node)` 经 `--` 传参回来是空的，
   经 `-e` 传参才对。后果是**装了 node 之后探测仍永远返回 "none"**，Linux 测试永远不跑、门禁永远"阻塞"——
   正是该文件开头警告的那种静默跳过，而它就藏在探测自己身上。已改用 `-e` + `--cd`。
3. **探测可能把 Windows 的 node 当 Linux 的**：WSL 把 Windows 的 PATH 注入 Linux PATH，本机就有 36 条
   `/mnt/...`。原来只问 `command -v node` 再跑 `-v`，一个 Windows `node.exe` 就能满足它——测试等于交给
   一个跑不起来的二进制。现在要求路径不在 `/mnt` 下且 `process.platform=linux`。

**门禁**：`check:sandbox-isolation`（`scripts/isolation-check.mjs`，已进 `check:offline`），
驱动**真实** `SandboxShell`，关键几条：

- 越界文件：无隔离**可读**、有隔离**读不到**（对照组即变异证据——拦不住它就会由"通过"变"失败"）；
- 工作区照常：`/ws`、node 可用、相对路径可读、指定子目录 cwd 落在 `/ws/packages/sandbox`；
- **挂载不外泄**：边界内 `/mnt` 里没有盘符，边界**退出后恢复**；
- **自检有效**：喂给它"没有 unshare、`SHE_NS0` 就是当前命名空间"，必须以 91 拒绝且不执行命令、不留挂载；
- 假绿防护：探测里确实排除了 `/mnt` 下的 node、校验 `process.platform=linux`、要求 >= 20。

**变异验证**：把 `mount -t tmpfs none /mnt` 注释掉重跑，`check:sandbox-isolation` 立刻两条转红、退出码 1
（"隔离开启时读不到"与"边界内 `/mnt` 里没有盘符"）；恢复后全绿。单测 30 项钉住纯函数与自检本身。

### 层 4.2 的后续修正：最大授权（勾选 +「所有」）让开真隔离

上面那句"要 Windows 工具的工作流写 `SHE_SANDBOX_ISOLATION=off`"不是唯一的答案，也**不该**是唯一答案：
设置页上「允许工作区外命令」勾选 + 档位「所有」的原文是"什么都不问，包括工作区外。仅限你完全信任的
本地环境"—— 那是一句关于**这台电脑**的话，而当时的实现只放开了审批与工作区边界，命令仍然进 WSL 命名
空间。于是越信任这台机器的用户越会撞上同一件事（本机实测 2026-10-03）：

```
allowAllCommands=true / outsideWorkspace={allow:true,policy:'all'} / isolation=auto
exec('ver')  ->  exit 127   bash: line 1: ver: command not found
```

`ver` 是 cmd.exe 的内建命令，这条报错看起来像命令写错了，而不像"你被关在边界里"。现在的判据
`isMaxGrant()` 承认这件事：**勾选 +「所有」就是"就在这台电脑上跑"**，因此 `effectiveIsolationMode()`
把档位合成 `off`（`wsl` 也一起让开 —— 用户已经明确说了要在这台机器上跑，把它拒绝掉才是违背他的选择）。

三处一起改，少一处这条改动就等于没做：`admit()` 决定怎么 spawn、`isolationApplies()` 决定
`shellName()` / `dialect()` 怎么描述（描述必须说主机 shell，`ver` 不能在被说成隔离的同时跑起来）、
`describeIsolation()` / `isolationNotice()` 决定界面与启动日志里怎么说。让开的**只有隔离**：审批、
破坏性命令、工作区边界本来就由这一档放开，命令白名单（`allowedCommands`）是用户单独打开的另一个
fail-closed 开关，不受影响。

说出来的部分与动作一样重要：提示同时给出**后果**（命令直接在主机上运行）、**是谁造成的**（档位
「所有」）、**怎么收回去**（调回「只读」/「拒绝」），并点明"去打开 `SHE_SANDBOX_ISOLATION` 没用"——
那一格最自然的动作就是去开那个开关，而这一档会盖过它。设置页那一节、启动日志、以及每条命令的回执
（让开时不带 `isolation` 字段）三处一致。

**门禁**：`check:sandbox-isolation` 新增第 4b 节 —— 判据表（8 格：两个控件缺一不可、`wsl` 与 `auto`
都被盖过、其余档位原样保留）、事实（最大授权下真跑 `ver` 必须成功、结果里没有 `isolation`、描述不说
"WSL 隔离内"）、对照（同一台机器、同一档位改成「只读」，边界必须回来且 `ver` 必须再跑不到）。
`check:shell` 侧新增提示文案五格与"设置页真的渲染了 `isolation.notice`"的静态断言。单测（
`isolation.test.ts`）把纯决策钉成与机器无关的断言，这样没装 WSL 的 CI 也能挡住两个方向的回归。
变异：删掉 `effectiveIsolation()` 的让开 → 事实那条转红；把让开放宽到任何档位 → 对照那条转红。

### 层 4.3 落地明细（shell 方言）

**问题（第四轮 3a / 3b）**：沙箱在 Windows 上把命令交给 `cmd.exe`（`spawnCommand`），而模型按习惯写 POSIX。
cmd.exe 语法上不认那些写法，于是命令**跑了、退出码 0、意思变了**：

| 写的 | cmd.exe 实际做的 |
|---|---|
| `echo $HOME` / `echo ${HOME}` | 打印字面 `$HOME`（cmd 取变量用 `%VAR%`） |
| `echo $(date)` / `` echo `date` `` | 打印字面文本，不展开 |
| `cp 'a b.txt' out` | 单引号不是引号 → 拆成两个参数 |
| `cd ~/project` | 找名为 `~` 的目录 |
| `VAR=x cmd` | 把 `VAR=x` 当程序名 |
| `2>/dev/null` | 没有 `/dev/null`（是 `nul`） |
| `# 注释` | 把 `#` 当命令执行 |

**做法（两半，与 4.1 同一个取舍：不拒绝，说清楚）**：

1. **3b 说在前面**：`shell` 工具的描述里点名真正会解析命令的那个 shell（`SandboxShell.shellName()`；
   非隔离时它来自 `resolveShell()` 解析 `sandbox.shell`），cmd.exe 档位下把上表逐条写进描述。
   POSIX 档位不写 —— 模型默认按 POSIX 写，反过来念一遍只是噪音。
   **第七轮修**：`shellName()` 原来只读 `config.isolation !== 'off'`（用户要的），`auto` 用不了时
   会声称"由 WSL 里的 bash 解析"，于是这一节整张差异表被静默关掉。现在它问 `planIsolation()`（会发生的），
   判据与变异验证见「层 4.2 → 默认档位」。
2. **3a 错了说清**：`detectShellDialectMismatch()` 在 `admit()`（与 `codeExecution` / 边界同一处收口）
   扫一遍命令，命中的构造随结果下发（`SandboxResult.shellDialect` / `SandboxJobView.shellDialect`），
   由 `shellDialectDisclosure()` 渲染成一段话：哪个 shell / 哪处不是那个意思 / 该写什么。

**刻意的边界**（每条都有对应的断言，免得被读成"没做完"）：

- **不拒绝、不重写**。`git commit -m "fix $X"` 可能就是要字面文本；把 `${VAR}` 自动改成 `%VAR%`
  会把"已报告的差异"变成"静默的改写"。
- **不越权**：交给别的解释器的程序文本不扫（`node -e "a${b}c"` 里是 JS 模板字符串，
  `powershell -Command "$(Get-Date)"` 是 PowerShell 自己的替换）。**例外**是 `cmd /c "…"` ——
  那里的程序仍然由 cmd 解析，照报（否则"套一层 cmd /c"就成了让提示消失的办法）。
  **包装程序也算"别处"**（第七轮补）：`wsl … bash -lc "…"` 与 `docker exec … bash -lc "…"` 里的
  程序由发行版 / 容器里的 shell 解析，第一个 token 却是 `wsl` / `docker` —— 于是整段被当成 cmd 的
  文本。实测那次回执里**报了两处方言警告，两条都是误报**（`$VAR` 与 `'单引号'` 都落在 bash 的程序
  文本里）。现在 `handsOffToForeignShell()` 把这类段整段跳过。刻意**跳整段**而不是只去引号：
  `wsl … echo $HOME` 里的 `$HOME` 是故意留给 bash 展开的，cmd 不展开它正是想要的行为。
  这一条也刻意**窄**：`docker` 只在 `exec` / `run` **且参数里点了 shell 名**时才算交出 ——
  `docker run img echo $HOME` 由 docker 直接 exec `echo`，`$HOME` 原样过去，此时"cmd 不展开
  `$VAR`"这条提示是**对的**，吞掉反而是漏报。
- **隔离开着时不报**：那时命令在 WSL 里由 `bash -lc` 解析（`buildConfinedScript`），POSIX 才是对的，
  报差异反而是假警报。
- **没有差异就不附**：报告只在命中时出现，`echo %USERPROFILE%` 与 `node -v` 的回执里没有这段。
- **每类只报一次、最多三条**：要点名错误，不是清点错误。

**门禁**：`check:shell` 第 7 段（`scripts/shell-check.mjs`）驱动**构建产物**（`dist`，不是 `src`）
断言两半都在：描述里点名 shell 且 cmd 档位下列出差异；`echo $HOME` **退出码 0 且输出是字面 `$HOME`**
（这条断言就是把"静默"钉成事实）；结果里点名差异、回执里有说明、且**不含 `DENIED`**；
`node -e "…${a}…"` 不误报、`cmd /c "…${HOME}…"` 照报；POSIX 档位反向断言（描述里不出现 `%VAR%`）。
单测 35 项（`packages/sandbox/src/__tests__/shell-dialect.test.ts`）覆盖同一批规则，
含"每类只报一次 / 最多三条"、"没差异不附报告"与"包装程序只吞自己那一段"。

**变异验证**：撤掉描述那一行（3b）→ 描述相关的 7 条转红；把 `gaps` 强制成空（3a）→
"结果里点名了这处差异"与"回执里有这段说明"转红；把 `handsOffToForeignShell` 的跳过关掉 →
"包装程序后面的程序文本也不报"与"不是见到 docker 就闭嘴"转红。恢复后全绿。

### 层 5 落地明细（窗口之间）

**问题**：多个窗口只是给**一个**后端多开了几个窗口。工作区根、LSP 根都是**进程级全局**的，所以窗口 B
切工作区会把窗口 A 一起带走 —— 这正是实测报告里 D1「LSP 根错位」的真实性质（不是路径算错，是跨窗口
根污染）。两个窗口开同一个项目时还会更糟：两个后端进程各自在内存里存一份会话快照、各自回写
`sessions.json`，先写的被后写的覆盖，用户看到"聊天记录自己消失了"。

**设计**：**一个工作区一个后端进程**，窗口接到它上面。

- 键是**工作区**而不是窗口。因为会话、知识库、审计日志都住在工作区目录下（`<ws>/.she/`），
  一个工作区只该有一个进程持有它们 —— 这是"两个窗口开同一项目"时不会丢数据的唯一做法，也
  就是用户要的规则：**先到窗口拥有这个项目，新窗口接上去而不动它**。
- 靠 `SHE_WORKSPACE` 决定进程挂哪个工作区（配置加载器在启动时读进 `config.workspace.root`），
  所以**不需要改服务端**：为 W 起的进程就是 W 的后端。
- 池**删掉** `SHE_STATE_DIR` 与 `SHE_KB_PATH` 再启动子进程：状态必须跟着工作区走；继承一个共享
  状态目录就会把两个进程放到同一份 `sessions.json` 上。
- `check:window` 分两层：**单元测试**（假子进程）钉住池的不变量 —— 同一工作区只起一个、并发只起一个、
  已登记占用的端口不再分配、启动失败不被缓存成永久失败；**静态断言**盯住接线，因为池写好了没接进
  Electron 等于没修（界面由开发服务器提供时显式禁用池；启动器那个后端要登记；渲染进程优先走原生
  切换、把页面内 `POST /api/workspaces/switch` 留作纯浏览器回退；换 origin 后由 `?ws=` 交接，
  因为 `sessionStorage` 按 origin 隔离）。

**实测（第一轮，失败）**：真机跑多窗口，`openWorkspace failed: 没有可用端口（已尝试 5700–5739）` 出现两次，
紧接着回退到共享切换 —— 表现成「新窗口强制打开旧窗口的工作区」。两个缺陷叠在一起：

- **写死端口区间**：`portStart: 5700, portSpan: 40`。实测这台机器 `netsh interface ipv4 show
  excludedportrange protocol=tcp` 显示 Windows 保留了 5441–5540 / 5541–5640 / **5641–5740**，
  5700–5739 逐端口试 bind **可用 0 个**。保留段在 `netstat` 里看不到，所以"挑一段看起来空的"
  这种方法在别的机器上能过、在这台机器上全军覆没。改为**绑 0 号端口让系统分配**：系统不会把
  它自己保留的端口发出来，问题从根上消失。
- **失败被吞成"不支持"**：`she:openWorkspace` 把异常 catch 成 `null`，渲染进程把 `null` 读成
  "这个 shell 没有池"，于是回退到页面内 `POST /api/workspaces/switch` —— 那是**共享**后端的切换，
  会把别的窗口一起带走。这是比端口更难查的一半：它在"已经出错"的时候才发生，而且是静默的。
  现在两种信号严格分开：**返回 `null` = 没有池**（唯一允许回退的情况），**抛错 = 有池但没做到**
  （绝不回退，直接报错）。

**实测（第二轮，通过）**：用真的 `BackendPool` + 真的 node 子进程起两个工作区 ——
端口由系统分配为 `24418` / `24427`，各自 `/api/workspaces` 的 `current` 与目标目录逐字相同、
互不相同，同一工作区再问一次复用同一进程（spawn 计数仍为 2），两个后端的会话列表无交集，
且 `.env` 里的 `SHE_WORKSPACE` 没有把它们带走。`check:window` 把这两个事故形态都钉成了断言。

**实测（第三轮，用户真机复现通过）**：用户重启后自己开了一个新窗口进 `<projects-root>\_she-scratch_2`，
`desktop.log` 记下 ——

```
pool: registered existing backend for C:\Users\<user>\Desktop\aaa at http://127.0.0.1:5777
pool: starting backend for <projects-root>\_she-scratch_2 on 25646
window moved to backend for <projects-root>\_she-scratch_2 (http://127.0.0.1:25646)
```

端口 `25646` 由系统分配（不再是 5700–5739），新窗口的 `desktop-ws-25646.log` 里
`State dir: <projects-root>\_she-scratch_2`、`Knowledge base mounted: <该工作区>\.she\kb.sqlite`、
`Opened session sess_0a1b2c3d4e5f` —— 独立的状态目录、独立的知识库、独立的会话。
同一时刻两个后端并存且指向不同工作区（`aaa` 与 `_she-scratch_2`），互不影响。

**已知代价：配置是进程内的，`.env` 是共享文件 —— 已用广播消掉。**

这是"一个工作区一个后端"换来的真实代价，曾如实记在这里，现在说明它的处置，以免它被当成 bug 重新发现：
单价 / 压缩档位 / 推理档位这些活在**每个进程自己的 `config`** 里，而 `PUT /api/settings` 落盘的是
**共享的 `.env`**，且启动时才读一次。所以**窗口 A 改设置，窗口 B 的运行中后端不会立刻跟上**。

实测（2026-10-01）：A(5777) 把输入单价改成 7 之后，A 读到 `7/15/0`，B(25646) 仍是 `1/15/0`。

**处置：写入后由桌面壳广播，而不是让各后端自己去"重读配置"。**

渲染进程的每一处设置写入都走 `putSettings()`（`packages/ui/src/lib/api.ts`）；它在 PUT 成功后再
通知壳，壳把**同一个 body** 用 `PUT /api/settings` 重放给池里其它后端（跳过发送方自己，它已经应用过）。

- **为什么复用 PUT 而不是加一个"重载"接口**：那个 handler 已经负责同步 `process.env`、判断改动是否
  结构性到要重建 agent、工作区变动时迁移状态。另写一套重读逻辑就得把这些再实现一遍，两处必然漂移。
- **必须剥掉工作区字段**（`SETTINGS_NOT_FORWARDED = ['workspaceRoot', 'kbDbPath']`）。实测过后果：
  把 `workspaceRoot` 也转发出去，B 的工作区当场从 `<projects-root>\_she-scratch_2` 被搬到
  `C:\Users\<user>\Desktop\aaa`（HTTP 200，静默生效）—— 那正是这套池要消灭的跨窗口污染。
- **动词必须是 PUT**：`/api/settings` 没有 POST 路由，第一版写成 POST 只会拿到 404，广播静默失效
  （是端到端实测发现的，静态断言也没抓到）。
- 广播失败只记日志：写入本身已经成功，够不到的窗口下次启动仍会读同一个文件。

`check:window` 第 7 节钉住这条链路的每一环，并有一条**反向**断言：`packages/ui/src` 下除
`lib/api.ts` 之外不允许再出现直连的 `PUT /api/settings`。广播属于"以后多加一个调用点就会忘"的
那类代码，少了它哪一项设置就悄悄退回"只在本窗口生效"，而测试和界面都不会有任何反应。

## 4. 顺序与检查点

| 步骤 | 产出 | 验收 | 状态 |
|---|---|---|---|
| 1 | 层 1 全量 | `check:data` + worktree 残留门禁 + 真机子级跑一轮 | **完成** |
| 2a | 层 2.1 迁移脚本 | 迁移对账输出 + 备份可回滚 | **作废**（按 D3：不迁移，旧数据丢弃） |
| 2b | 层 2.2 结构收紧 | `check:session` 全绿 + 变异验证转红 | **完成** |
| 2c | 层 2.3 界面 | 真机两会话交叉手测 | **完成**（选择器 + 只读横幅；真机切会话核对过） |
| 3 | 层 3 存储 | 三条存储门禁 | **完成**（`check:data` 第 13 段；原子写 / 写前校验 / 损坏在接口与界面里说得出来） |
| 4.0 | 层 4.0 长命令 / 后台任务 | `check:background`（真进程 / 真等待 / 真数进程表；变异验证双向） | **完成** |
| 4a | 层 4.1 策略 + 文档 | `check:shell` 第 6 段逐条钉住 + 单测 52 项；变异验证三向（去掉披露 / 过度识别 / 不分段）全转发红 | **完成**（策略由"弹确认票"改为"照跑 + 如实披露"，理由见 4.1 明细）。**全量 `check:offline` 退出码 0**（2026-10-01）—— 中间顺带修掉两个一直没跑到的新失败：`check:data` 的进程交接竞态（固定 sleep 换掉服务，下一段读到上一个服务）、`check:portability` 的测试夹具里混进了作者本机路径 `<author-dir>/demo` |
| 4b | 层 4.2 真隔离 | 按平台门禁（可 skip）+ 真机试一条越界读取被拒 | **机制完成**（2026-10-01），**默认档位完成**（2026-10-03，第七轮）。机制：WSL2 私有挂载命名空间 + tmpfs 遮盖 `/mnt`，工作区 bind 到 `/ws`。门禁 `check:sandbox-isolation` 驱动真实 `SandboxShell`：越界读"无隔离可读 / 有隔离读不到"、工作区照常可用、边界内 `/mnt` 里没有盘符且退出后恢复、自检在未进命名空间时以 91 拒绝且不留挂载；变异验证（注释掉 tmpfs 遮盖）两条转红。**第七轮**：默认档位 `off` → `auto`（理由与代价见「层 4.2 → 默认档位」）、门禁新增「描述与事实」一段（`shellName()` 必须点名真会解析命令的那个 shell，三格断言 + 变异验证）、15 处检查脚本钉死档位并由 `scripts/lib/host-sandbox.mjs` 的守卫看着不再长回来。详见「层 4.2 落地明细」 |
| 5 | 层 5 进程隔离（窗口之间） | `check:window` 全绿 + 真机起两个工作区互不干扰 | **完成**（2026-10-01）。一个工作区一个后端进程：切换工作区只影响发起的那个窗口，不再动全局工作区根（LSP 根污染是同一处病）。**第一轮真机失败**并暴露两个缺陷 —— 写死端口区间（5700–5739 被 Windows 整段保留，一个都绑不上）与失败被吞成 `null` 导致回退到共享切换（把别的窗口一起带走）；分别改为**系统分配端口**与**返回 null 只表示"没有池"、失败必须抛错**。**第二轮真机通过**：两个工作区分别拿到 24418 / 24427，各自挂载目标目录，同工作区复用同一进程。门禁 `check:window` 把两个事故形态都钉住。详见「层 5 落地明细」 |
| 4c | MCP 通道收敛（根 + cwd，评测 9b） | `check:mcp` 第 5 段（配置层 / 行为层 / 历史层）+ `mcp-roots.test.ts` 6 项 | **完成**（2026-10-02）。真机现象：`C:\Users\<user>\.playwright-mcp` 下 340 个文件 —— 截图与 `console-*.log`，全是智能体用 playwright 通道做界面验证时留下的；`packages/server` 里也出现过页面快照，早就逼着打包脚本加了排除项。同一个原因：`spawn` 没给 cwd，子进程继承了 SHE 的启动目录（终端里是工作区，双击是 exe 目录），而 playwright 型服务按 `<cwd>/.playwright-mcp` 算产物目录。修法是把 cwd 钉在工作区（`confineMcpServer` / `mcpSpawnSpec`，两个启动点共用），顺带把相对命令按工作区钉成绝对路径、Windows 过 shell 时给带空格的命令与参数补引号（实测 Node 不补，cmd.exe 会把它拆开）。**真机验收**（一次性探针，不进仓库）：拿真的 `@playwright/mcp`（23 个工具，就是报告里那 23 个）按桥的方式以 cwd=新工作区起进程，`browser_navigate` + `browser_take_screenshot` 后产物落在 `<工作区>/.playwright-mcp`（2 项），`%USERPROFILE%\.playwright-mcp` 仍是 340 个文件（没长）。**变异验证**：去掉 `cwd: ws` 后第 5 段 5 条转红（产物落进后端子目录），恢复后全绿 |

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
- "沙箱拦截规则穷举"（`powershell -Command` / `python -c` / `git -C`）**已归到 4.1 门禁**：前两类识别为任意代码执行并披露
  （`check:shell` 第 6 段逐条钉住）；`git -C <绝对路径|..>` 本来就被路径检查拒掉（同一段里也钉着"看得见的越界路径"这条断言 ——
  V17 之后它按档位分开：未勾选档照旧拒，勾选 +「所有」档放行）。
- `sessions.json` 是否曾轮转：从盘上看没有轮转产物（只有损坏留底），按 I4 由层 3 统一解决。
