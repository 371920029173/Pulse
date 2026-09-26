# 导入外部上下文

UI「导入库」或 `POST /api/kb/import`，source：cursor / claude-code / codex / raw / session。

- Cursor：composer bubbles、messages、Markdown User/Assistant
- Claude Code：chat_messages、Human:/Assistant:
- Codex：mapping / items / messages
- 落点：组结构 `imports/<source>/<date>/`（非 RAG）；也支持 md/txt/json/jsonl；单次最多约 200 条
