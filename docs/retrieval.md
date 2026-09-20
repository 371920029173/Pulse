# 检索：结构共振，不是向量

PulseSeed 是这个项目的检索原语 —— **结构共振，不是余弦/嵌入 RAG**。

```
Query → Bootstrap Lookup → Create PulseSeeds → Structural Resonance Propagation → Collect & Score
         (找入口节点)      (每个种子节点)        (通过组/边传播，能量衰减)        (按激活能量排序)
```

每个结果都带 **ActivationTrace**：是哪几个组、哪几条边、经过几跳把能量传过来的。这是它和向量
检索最大的区别 —— 结果**可解释**，而不只是一个相似度分数。

## 硬规则

- 弱边 ≠ 语义相似性证明（weak edge ≠ similarity proof）
- 共现 ≠ 因果（co-occurrence ≠ causation）—— 永不自动提升
- 时序 ≠ 因果（temporal ≠ causation）—— 永不自动提升
- 因果候选边必须带 evidence + falsifiers
- 组分裂按结构均分，不用 K-means / 语义聚类
- 检索入口必须是结构共振 → PulseSeed，不加关键词/嵌入回退

## 组结构 → SHE v2 对照

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

## 它到底有没有用（实测证据）

诚实的答案比"比 RAG 更聪明"窄得多，而且是量出来的：

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

**增益来自"组路径"类查询，不是来自语义理解。** 看条数那一列：BM25 对组路径返回 `0`，
因为它索引的是记忆正文，而没有任何一条正文里写着 `ops/env`。结构检索能回答一类词法检索
**根本答不了**的问题：

> 问的是「知识放在哪里」，而不是「知识说了什么」。

在语义类用例上两者打平（都是 100%）。所以这个项目能诚实主张的是**结构可寻址性**，
不是更强的相关性排序。

**限定条件**：16 个用例、单一库形态、没有 embedding 基线。完整限制清单见
[`evals/retrieval/README.md`](../evals/retrieval/README.md)。

## 为什么不做向量

这是**刻意的设计选择，不是待办事项**。理由与代价都写在 [architecture.md](../architecture.md)：
向量检索把记忆变成不可解释的浮点向量，而组结构记忆的全部价值在于能说清"为什么命中"。
代价也很明确 —— 当前 provider 没有 `/embeddings` 端点，所以**无法声称强于向量检索**，
只能说强于纯 BM25。
