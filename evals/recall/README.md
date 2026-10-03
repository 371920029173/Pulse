# evals/recall — 意义型查询的召回评测

`evals/retrieval` 问的是「结构共振在可寻址的查询上是否胜过 BM25」。这里问的是一个真实 agent 碰到的问题：
查询只说了**意思**（「程序出错后如何避免重蹈覆辙」「how do I avoid repeating past mistakes」），和回答它的笔记
没有一个共同的词。

```bash
pnpm eval:recall                       # 合成装置库 fixture.json，达不到 cases.json 的 floors 就退出 1
node evals/recall/run.mjs              # 同上，只报告
node evals/recall/run.mjs --json
node evals/recall/run.mjs --db <kb.sqlite> --alias project/demo-app=project/<你的项目组>
                                       # 换成一个真实的库：先复制再查，原文件不会被打开写入
```

- `fixture.json` 是**手写的合成库**，组结构仿照一个用过一段时间的工作区（`errors/<tool>` 错题本、`errors/自省`、
  项目笔记、环境笔记、小项目、偏好、待整理），不含任何真实库的内容。
- `cases.json`：`meaning`（意义型，中英）、`lexical`（字面对照，必须不退步）、`negative`（主结果必须为空）、
  `heldout`（在调好 `retrieval-lexicon.ts` 之后才写、没有据其调参的意义型查询，衡量泛化）。
  三条 `live-*` 是那个 agent 实际发出的查询。
- 指标只算**主结果**（`result.nodes`）：hit@1、hit@5、MRR@10。兜底结果（`result.fallback`）单列，永远不算命中。
- 每条查询用库的一份新副本跑，因为 `query()` 会给返回的节点加访问计数，不复制的话用例顺序会改变分数。
- 不调用任何 LLM API。
