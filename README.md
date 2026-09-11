# SHE v2 — Structured Hierarchy Engine

> 结构化层级引擎 v2：基于组结构记忆 + 脉冲种子检索的本地编程智能体
> Thin agent-runtime with Group Memory KB + PulseSeed retrieval

A local coding/assistant agent that uses a **Group Memory knowledge base** with **PulseSeed structural resonance retrieval** — not traditional vector RAG. Talks to external LLM APIs (OpenAI-compatible + Anthropic).

**Landing path**: `D:\AGI\AGI-use`
**Design truth**: AGI-3.5-v2 + how-to-do docs (NOT AGI-3.5 max)

---

## Quick Start on Windows / Windows 快速开始

### Prerequisites / 前置条件

- Node.js ≥ 20 — https://nodejs.org
- pnpm — `npm install -g pnpm`
- Git

### 1. Clone & Install / 克隆并安装

```powershell
# Place under D:\AGI\AGI-use
cd D:\AGI\AGI-use
git clone <this-repo> .
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
# Open http://127.0.0.1:4578
```

---

## Scope — thin agent-runtime only

This is a **thin agent-runtime**, not the full AGI pulse-universe:

| In scope (Phase 1) | Out of scope |
|---|---|
| OpenAI-compatible external API agent | Full oscillator/pulse-universe kernel |
| Group-structure KB with PulseSeed retrieval | G6/G7 metacognition |
| ToolLoop (read/edit/run) | Pulse waveform encoding |
| Windows Job Object sandbox + `she` CLI | Continuous oscillation cycles |
| Sidebar sessions + PulseSeed visualization | Any reference to AGI-3.5 max |

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

Layered: defaults → `config.yaml` → environment variables

- `.env` — API keys (never committed)
- `config.yaml` / `she.config.yaml` — project settings
- `SHE_*` env vars — override anything

See `.env.example` and `config.example.yaml`.

## Tests

```powershell
pnpm test
# 62 tests: 41 KB engine + 21 sandbox
```

---

MIT
