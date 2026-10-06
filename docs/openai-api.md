# OpenAI 兼容面：把这个 Agent 当成一个服务

这个仓库自己的 HTTP 接口（`/api/chat` 等）是**为界面写的**：流式分片是本项目的形状、会话是显式参数、
状态行说中文。这一层是**给程序用的**：任何 OpenAI 客户端 —— 官方 SDK、别的编辑器、一段脚本 ——
都能通过 / 它驱动这个 Agent。

```
GET  /v1/models              # 客户端启动时问的第一个问题
POST /v1/chat/completions    # 非流式与流式（SSE）
```

```bash
curl -s http://127.0.0.1:5577/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"看一下工作区，然后告诉我它有多少个源文件"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:5577/v1", api_key="any")   # 本机服务不校验这个 key
r = client.chat.completions.create(model="she", messages=[{"role": "user", "content": "你好"}])
print(r.choices[0].message.content)
```

## 三件必须说清的事

### 1. 会话：无状态协议 ↔ 有状态 agent

OpenAI 的协议是**无状态**的（客户端每次都把整段对话再发一遍），而这个 Agent 是**有状态**的（计划、
知识库、按会话隔离的运行时状态）。映射规则只有一句：

| 客户端给的 | 我们怎么做 | 回在 `X-She-History` |
|---|---|---|
| 消息**比它能看见的历史多** | 认它 —— 用它的历史替换（客户端是权威） | `adopted` |
| 更少或一样多 | 只把它最后一条 user 消息当新输入，接在现有历史上 | `appended` |

"它能看见的历史"是投影后的那部分：工具行、以及带 `tool_calls` 的助手行是**我们自己**产生的，
客户端从没见过 —— 拿总条数比较会让"重发整段对话"永远被判成 append，它的编辑与截断就被无声忽略。

用哪条会话在 **`X-She-Session`** 头里回给你。想显式控制就带上 `X-Session-Id`（那就永远是 append），
不带则按"这段对话的开场消息"算一个稳定指纹：同一段对话永远落到同一个会话上。开场消息不同 = 新对话，
不会误接到别人的历史上。

### 2. 工具：它是 agent，不是回声

工具是这个 Agent 自己跑的。客户端**不会**收到 `tool_calls`，收到的是一段**已经跑完工具的答复**。
客户端发来的 `tool` / `function` 消息不丢：折成一条带标记的 user 消息（它们是别家 agent 的回显，
丢掉会让上下文出现空洞，而这里是唯一能保住它们的地方）。

### 3. 我们自己的读数在 `x_she` 里

标准字段照旧（`choices` / `usage` 都是 OpenAI 形状），额外的放在 `x_she` 命名空间下：会话 id、
上下文**分类账**（系统 / 工具表 / 摘要 / 工具结果 / 对话）、窗口来源、压缩经济学。忽略它不影响解析。

## 流式

`stream: true` 时是标准 SSE：每个分片是 `chat.completion.chunk`，最后 `data: [DONE]`。上游把流式关掉
（`SHE_LLM_STREAM=off`）或端点不支持流式时，**不会**给你一个空流 —— 整段答复作为一个分片发出去。

想看我们自己的状态行（"已按设置关闭流式"、"上下文压缩：…"这类）就加 `X-She-Status: 1`：它们以
`she.status` 对象出现在流里。默认**不发**，因为标准客户端不认识非标准对象。

## 错误

错误体是 OpenAI 形状：`{"error":{"message":"…","type":"invalid_request_error"|"server_error","code":null}}`。
会话忙（同一会话上一轮还没结束）回 **409**；流已经开始之后出错，错误作为一个 `she.error` 事件发在流里，
而不是改成 HTTP 错误码（那会变成"连接断了"）。

## 判据

`node scripts/openai-api-check.mjs`（`pnpm check:openai`，也在 `check:offline` 里）：起真 server + 本地桩
模型，钉的是路由形状**以及**"它真的是 agent"—— 其中一条断言是「桩只被喂过"要工具"，而答复里那句
只可能来自工具执行完之后的第二次请求」。
