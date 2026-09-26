# 外挂知识库（共享 SQLite）

用户要「外挂库 / 多开共用记忆」时用。

- KB 是组结构 PulseSeed（SQLite），不是向量 RAG
- Settings → 外挂知识库路径 → 写 `SHE_KB_PATH`；**改路径后须重启服务**
- 默认：工作区 `.she/kb.sqlite`；外挂用绝对路径
- 多进程共享时避免两端同时破坏性写入

红线：禁止 K-means/语义聚类建组；禁止关键词/embedding 检索兜底；弱边不得偷升因果。
