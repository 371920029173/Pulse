# SHE 能力地图

用户问「还能干什么 / 像不像 Cursor」时用。

## 已具备
流式对话与工具环、确认票、「允许所有命令」、文件树与 @file/@folder、Diff、检查点撤销、会话管理、终端、Ctrl+K、主题与可拖拽布局、PulseSeed KB、外挂库路径、Electron 桌面窗、定时任务、技能档位、@symbol/大纲、导入 Cursor/Claude/Codex、长任务卡。

## 常见缺口
| 情况 | 建议 |
|---|---|
| 未填 API key | Settings 填 key，或 Ollama/LM Studio |
| 要任意 shell | Settings 开「允许所有命令」 |
| 要向量 RAG | 说明红线：组结构 KB，非 embedding |
| 桌面窗 | 用 SHE.bat；UI 默认 http://127.0.0.1:5577 |

## 捷径
Ctrl+K · 双击会话名重命名 · 状态栏切主题/时间线

## 四种手段（所有档都有，别换个 profile 就忘了）

| 手段 | 工具 | 什么时候用 | 什么时候别用 |
|---|---|---|---|
| **地图** | `map_tree` / `map_lookup` / `map_whereis` / `map_scope` / `map_impact` / `map_wiring` / `map_contracts` / `map_verify` | 不知道"哪里是干什么的"、改之前要算影响面、要看谁用了某个符号 | 已经知道确切路径、只读一个文件 |
| **派活** | `task_spawn`（`background: true` 即发即走） | 活很宽（翻很多文件/跑很多命令）、不需要逐步盯着、用户明确要并行 | 几轮就能自己做完、每步都要你判断、要用中间结果决定下一步 |
| **等什么结束** | `task_status({ ids, wait: true })`、`shell_wait({ ids, mode: "all"｜"any" })` | 发出去之后干别的，回来要结果 | 不要轮询（本仓明确禁止 poll） |
| **长程** | 计划 + 自动续跑 | 多步任务：一步一 `plan_update`，做完为止 | 不再有"两轮没进展就停"的门限；停由你判断（做完/撞上限） |

细节：`project-map`（地图怎么用）、`she-capability`（本事全貌）。
子代理**不能**再派子代理（防递归）；并发默认池 6（`SHE_SUBAGENT_CONCURRENCY`）。
