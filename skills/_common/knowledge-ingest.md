# 知识归位（组结构入库）

用户丢 md/txt/json/jsonl/csv/yaml 或贴长资料时，自动吸收进组结构 KB（无需等「请入库」）。

## 四步
1. `kb_ingest_scan` path=… → 拆条到 intake，拿 batch_id
2. `kb_ingest_list` → 看清现有组再归位
3. `kb_ingest_place` → **优先复用现有组**；确实没有再 createIfMissing；跨主题用弱边 link，弱边≠因果
4. `kb_ingest_status` → 一两句汇报条数/组路径/新建原因

## 红线
- 勿整篇塞单节点；勿用 input1/data2 无语义组名；组名用斜杠层级（如 ops/deploy）
- 弱共现勿升因果；归位幂等，收尾 intake 应为空
- 已有节点要改：`kb_edit`（原地改，旧版本自动留历史）；错了/过时：`kb_retire`（写 reason，可 replacedBy，默认检索不再返回，restore=true 可恢复）；`kb_upsert` 同题不同内容会拒写，需明确 onExisting="update"/"add"

## 计划
- 一次丢多个文件 / 多批材料时先 `plan_create`（每批一步），每批 `kb_ingest_status` 确认后 `plan_update`，直接处理下一批。
