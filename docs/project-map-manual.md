# 项目地图 · 使用手册

> 给**模型**用的代码地图，同时给人一个能看懂的入口。  
> 契约（字段/预算/版本）见 `docs/project-map-schema.md`；本手册讲**怎么用**。

## 1. 它解决什么问题

大项目里最耗时的事不是写代码，是**不知道哪里是干什么的**：

- "我要改导出功能，从哪下手？" → 目录树给不出答案，`grep` 给出一堆噪音；
- "改这个共享函数会坏谁？" → 靠记忆猜；
- "这行代码为什么变成这样？" → 翻十几次提交；
- "改坏了想只退一个文件" → `git checkout` 会顺手把别人的改动也带走。

地图把这几件事变成一次调用：**整仓骨架 + 每文件一句话标签 + 谁调用谁（带符号名）+ 影响面与闸门 + 可信度**。

## 2. 三个入口

| 入口 | 怎么用 |
|---|---|
| 界面 | 状态栏「地图」按钮，或命令面板（Ctrl+K）「项目地图（只读）」 |
| 命令行（工作区根目录） | `pnpm map:build`、`pnpm map:query <子命令>` |
| 工具面（模型） | `map_tree` / `map_lookup` / `map_whereis` / `map_scope` / `map_impact` / `map_wiring` / `map_contracts` / `map_verify` / `map_note` |

**一个工作区一套**：地图在 `<工作区>/.she/map/`，只在跑过 `map:build` 的目录里存在。
别的仓里找不到是正常的；第一次调用 `map_*` 工具会**自动建图**（几百毫秒）。

## 3. 建图

```bash
pnpm map:build                 # 全仓
node scripts/map-build.mjs packages   # 只建一个子树（渐进式接入）
```

- 数据来源是 `git ls-files`（文件清单 + 内容 sha），**不进 git**、不上传；
- 排除：构建产物、二进制、单文件 >2MB、`.env` 与密钥类文件（永不索引）；
- 生成物（`.pb.ts` / `.min.js` 等）打 `generated` 标——读它白读，改它会被覆盖；
- 重建**不丢标注**：标签/注记/知识绑定按 `branch:path` 合并保留。

## 4. 六个查询

| 命令 | 一句话 |
|---|---|
| `map:query tree [--budget 2000]` | 整仓骨架，每个文件一行标签；超预算自动折叠冷目录 |
| `map:query lookup <路径>` | 是什么/干什么/**何时读** + 组 + 符号大纲 + 接线 + 注记 + 相关 KB 知识 + 最近改动 |
| `map:query whereis "<一句话>"` | 意图 → 位置（两级收窄：先分片、再节点） |
| `map:query scope "<任务>"` | 工作集：锚点 → 会被波及 → 要跑哪些 check |
| `map:query impact <路径…>` | 反向依赖（**值导入**＝会运行出错 / **仅类型**＝只需重编译）+ 闸门 + 相关测试 |
| `map:query wiring <文件>` \| `--symbol <名字>` | 接线：A 用了 B 里的哪个符号 |
| `map:query contracts` | HTTP 契约：确定 / 潜在威胁（带反证条件）/ 无法对账 |
| `map:query verify` | 可信度：过期率 / 黑暗角落 / 悬空边 / 坏分片 |

### 接线是什么
`import { c } from './b'` → 边 **`A --接线 c--> B`**。支持的写法：命名导入（别名算源名）、default、
`* as ns`、`import type`；C 的 `#include "x.h"` 记 `接线 x.h`（系统头不建边）。
还有 Python、Go、Rust、Ruby、Java/Kotlin、PHP（C# 暂缺，见 §9）。

## 5. 标注（让它越来越有用）

建图只给**结构**；标签是干活时写进去的，`map_tree` 里显示「(未标注)」表示还没人写过。

```bash
# 单条
pnpm map:note --path src/a.ts --label-text "会话主逻辑" --what "流式与跟随规则" --when "改会话流时"
pnpm map:note --path src/a.ts --kind pitfall --text "改之前先看调用方"

# 批量：先出候选（只输出、不写盘），审完再写
pnpm map:suggest --out .she/tmp/notes.json
pnpm map:note --json .she/tmp/notes.json --dry     # 先看
pnpm map:note --json .she/tmp/notes.json           # 再写
```

候选来自内容本身：测试取 `describe/it`、md 取一级标题、脚本取首行注释；**没有信号的不产出**。
目录不需要逐条标：没有人工标签的目录会按子节点聚合出「A、B 等 N 项」。

## 6. 指纹与可信度

- 每条标签绑**内容 sha**：内容变了标 `stale`，**不删除**（"之前什么样"要留得住）；
- `map:query verify` 给 0–100 分 + 分项：过期率、黑暗角落、悬空边、孤立注记、坏分片；
- **0 标签时分数封顶 30 并明说"意图检索不可用"**——这时 `whereis`/`scope` 只能按路径匹配。

## 7. 收编（用别处的地图）

```bash
pnpm map:query adopt <别的工作区根> [--prefix 旧路径=新路径 …]
```
只写**引用**（外部根 + 分片 + 路径 + sha），不复制正文；读取时回外部取。
你**改**某条时才落地，并记 `derivedFrom`。外部取不到会明说"取不到，不是不存在"。

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
"我没看见地图" | 那个工作区没建过图。跑 `pnpm map:build`，或第一次调 `map_*` 自动建 |
`whereis` 什么都找不到 | 标签密度低。先按路径找 + 边干边标注（`map:suggest` 批量初筛） |
接线是空的 | 该语言还没有抽取器，或引用写成了解析不到的路径（如 C 的 `-I` 目录） |
`impact` 说"没有文件 import 它" | 裸包名（`@she/shared`）只建到**包根**，看「包级」那一栏 |
面板点开是空 | 服务端是老进程（没重启）；或该会话刚开始还没有内容 |

## 9. 已知缺口

- **C#**：`using App.Models;` 指向目录，当前只试了文件形式 → 接不上（交给外部贡献者）；
- **Java/Kotlin/Ruby/PHP**：抽取器已实现，但还没有独立判据；
- 契约图对**变量拼接的 URL** 无法对账（单列一栏，不当作"零问题"）；
- 面板目前只渲染树，**没有接线视图**（接线在 `lookup` / `wiring` / `impact` 里看）。

## 10. 隐私与边界

- 地图只存**路径、标签、边、注记**，不存文件正文；
- `.env`、密钥、二进制、>2MB 文件永不索引；
- `.she/` 在 gitignore 里，不进仓库；想共用：`SHE_MAP_PATH`（对称 `SHE_KB_PATH`）。
