# @she/kb — Group Memory

小组结构记忆的**检索与治理**内核：记忆按组树组织，检索用 **PulseSeed 结构共振 + 词法入口的混合**，
每条结果都带着**激活轨迹**（是哪些组、哪些边、几跳把这条记忆拉上来的）。

这不是向量检索。这个包刻意**不含 embedding、不含向量索引**：词的入口是 BM25，关系的召回是沿组图传播，
两者归一到同一个分数量纲。理由在仓库的 `docs/retrieval.md`（含两套公开基线的读数）。

## 装什么

```bash
npm i @she/kb @she/shared better-sqlite3
```

`better-sqlite3` 是原生模块（存储层），需要能编译或拿到预编译包。

## 最小用法

```js
import { loadConfig } from '@she/shared';
import { KBStore, GroupKBEngine } from '@she/kb';

// 配置与工作区：一个目录就够了（.env / she.config.yaml 没有就用默认值）
const config = loadConfig('/path/to/workspace');

const store = new KBStore('/path/to/workspace/.she/kb.sqlite');
const engine = new GroupKBEngine(store, config.kb);

// 写：组树 + 记忆
const group = engine.createGroup('project/decisions');
store.createMemory({
  kind: 'fact',
  groupIds: [group.id],
  title: '为什么不上向量检索',
  content: '词的入口用 BM25、关系召回沿组图传播；引入 embedding 会让检索不可解释，'
    + '而激活轨迹正是这个库要给出的东西。',
});

// 读：一次查询（关键词或一句语义话都可以）
const result = engine.query('检索为什么不用向量', { budget: 5 });
for (const hit of result.nodes) {
  console.log('命中：' + hit.title);
}
// 激活轨迹是**平行数组**（不是挂在每条 hit 上）：它解释'这条是怎么被拉上来的'
for (const t of result.traces.slice(0, 3)) {
  console.log(t.nodeId, '←', t.groupPath.join(' → '));
}
```

## 这台引擎的四个约定

1. **结果必须能解释**：`trace` 是激活路径（组 / 边 / 跳数），不是"相关性分数"的黑箱。
2. **边分类型**：`co_occurrence` / `temporal` / `weak` / `causal_candidate`。前三种**永不**升级成因果；
   `causal_candidate` 必须带证据与否证条件。
3. **弱命中单独回**：语义类查询若最佳命中仍弱，更宽的片段召回会放在 `fallback` 里 —— 不混进 `nodes`，
   调用方看得见"这是近似"与"这是命中"的区别。
4. **退役不是删除**：`kb_retire` 保留正文与历史，只是不再参与检索；改正用 `kb_edit`（旧版本进历史）。

## 版本与发布

- 版本跟仓库走（当前 `0.3.0`）。`0.x` 期间：破坏性改动走 minor，修 bug 走 patch。
- **发布顺序**：先 `@she/shared`，再 `@she/kb` —— 后者把 `workspace:*` 依赖在打包时写成前者的版本号，
  前者没发布的话，装 `@she/kb` 的 tarball 会去 registry 找一个不存在的包。
- 打包前先在空项目里验一次（仓库脚本 `scripts/kb-pack-check.mjs`）：pack 两个包 → 装进临时项目 →
  import → 跑一次 `query`。需要网络，所以它**不在** `check:offline` 里。

## 许可

Apache-2.0（见 `LICENSE`）。
