# SHE v2 — Structured Hierarchy Engine

> 结构化层级引擎 v2：基于组结构记忆 + 脉冲种子检索的本地编程智能体

A local coding/assistant agent that uses a **Group Memory knowledge base** with **PulseSeed structural resonance retrieval** — not traditional vector RAG. Talks to external LLM APIs (OpenAI-compatible + Anthropic).

**Target deploy path**: `D:\AGI\she-v2`
**Design truth**: AGI-3.5-v2 + how-to-do docs

---

## Quick Start / 快速开始

### 1. Install / 安装

```bash
# Clone and install
cd D:\AGI\she-v2
pnpm install
pnpm build
```

### 2. Configure / 配置

```bash
# Copy and edit config
copy .env.example .env
# Set your API key in .env:
#   OPENAI_API_KEY=sk-your-key-here
#   OPENAI_BASE_URL=https://api.openai.com/v1  (or any compatible endpoint)
```

### 3. Verify / 验证

```bash
pnpm she doctor
```

### 4. Ingest sample data / 导入示例数据

```bash
pnpm she kb ingest sample-workspace
```

### 5. Chat / 对话

```bash
pnpm she chat
```

### 6. Web UI / 网页界面

```bash
pnpm dev
# Open http://127.0.0.1:4578
```

---

## 组结构 → SHE v2 对照 / Group Structure Adaptation

| 组结构概念 (AGI-3.5-v2) | SHE v2 实现 | 说明 |
|---|---|---|
| 组 (Group) | `Group` — 多叉树 + 交叉引用 | 基本组织单元，包含记忆节点和子组 |
| 记忆节点 | `MemoryNode` — text/code/fact/preference | 实用载荷，非脉冲波形 |
| 弱边 | `Edge` kind=weak | 预激活可达性提示，非相似性证明 |
| 共现边 | `Edge` kind=co_occurrence | 共同出现，无因果声明 |
| 时序边 | `Edge` kind=temporal | 时间顺序，非因果 |
| 因果候选边 | `Edge` kind=causal_candidate | 需要 evidence + falsifiers |
| 竞争子组 | `Group` isCompetitionSubgroup=true | 矛盾候选，上下文选择，不强制合并 |
| 用进废退 | accessCount + isDormant | 访问增强，长期不用→休眠→压缩 |
| 脉冲种子 | `PulseSeed` 结构共振传播 | 非嵌入相似度，可解释的激活路径 |

### 非目标 / Not Ported

- ❌ 完整振荡器/脉冲宇宙内核
- ❌ G6/G7 元认知层（Phase 1 范围外）
- ❌ 脉冲波形编码
- ❌ 任何 AGI-3.5 max 的引用

---

## PulseSeed Retrieval / 脉冲种子检索

PulseSeed 是检索原语，替代传统 RAG 的余弦相似度。

```
Query → Bootstrap Lookup → Create PulseSeeds → Structural Resonance Propagation → Collect & Score
         (找入口节点)      (每个种子节点)        (通过组/边传播，能量衰减)        (按激活能量排序)
```

每个结果都带有 **激活追踪 (ActivationTrace)**：哪些组、边、跳数导致了激活。

**硬规则 / Hard Rules**:
- 弱边 ≠ 语义相似性证明
- 共现 ≠ 因果
- 时序 ≠ 因果
- 因果候选边必须带 evidence + falsifiers
- 永不自动提升边类型

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
| `she chat` | 交互式对话 Interactive chat with agent |
| `she kb ingest <path>` | 导入文件/目录 Ingest files into Group KB |
| `she kb query <text>` | PulseSeed 查询 Query KB with activation trace |
| `she kb stats` | KB 统计 Show KB statistics |
| `she doctor` | 系统检查 Check system health |
| `she server` | 启动服务器 Start API server for web UI |
| `she help` | 帮助 Show help |

## Configuration / 配置

Layered: defaults → `config.yaml` → environment variables

- `.env` — API keys (never committed)
- `config.yaml` — project settings
- `SHE_*` env vars — override anything

See `.env.example` and `config.example.yaml`.

---

## License

MIT
