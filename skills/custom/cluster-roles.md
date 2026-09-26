# 集群协作（讨论群运行时）

SHE「自动化讨论群」：多人同房发言，支持并行波次（类似讨论群机制）。

## 入口
- 状态栏「讨论群」/ Ctrl+K「打开自动化讨论群」
- API：`/api/cluster/rooms`、`/api/cluster/rooms/:id/run`

## 默认角色 skill
- 领导 `custom/cluster-leader.md`
- 后勤 `custom/cluster-logistics.md`
- 文案 `custom/cluster-copy.md`
- 研发 `custom/cluster-eng.md`
- 审查 `custom/cluster-review.md`

跑波次前会从磁盘重新加载 skill。「初始化角色 skill」可用 LLM 重写这些文件。

## 一波流程（并行）
1. 领导拆解与分工
2. 并行：后勤 + 文案 + 研发（同一 parallel_group，共享波次前快照）
3. 审查
4. 领导汇总与下一步

## 注意
- 多角色 LLM 并行，不是多 OS 沙箱进程。
- 落地改代码：把研发结论带回主对话执行工具。
- 扩展部门：加 DEFAULT_MEMBERS + cluster-<id>.md，并配置并行组名单。
