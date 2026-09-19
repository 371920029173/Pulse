# 写一个 SHE 插件

插件给智能体加工具。整个过程不需要改 SHE 的源码。

---

## 30 秒上手

打开 **扩展坞 → 新建**，填个名字点「创建骨架」。会生成一个**能直接跑**的插件：

```
~/.she-app/plugins/你的插件名/
├── manifest.json    声明：叫什么、需要什么权限、提供哪些工具
└── index.mjs        实现：工具的代码
```

然后点该插件的 **编辑**，改完保存 —— **立即生效，不用重启**。

## 一个完整例子

**manifest.json** — 告诉模型有这个工具：

```json
{
  "name": "pdf-tools",
  "version": "0.1.0",
  "description": "把 PDF 里的文字抽出来",
  "enabled": true,
  "permissions": ["read"],
  "tools": [
    {
      "name": "pdf_text",
      "description": "Extract the text of a PDF in the workspace. Use when the user asks about a PDF's contents.",
      "parameters": {
        "type": "object",
        "properties": { "path": { "type": "string", "description": "PDF path relative to the workspace" } },
        "required": ["path"]
      }
    }
  ]
}
```

**index.mjs** — 实现它：

```js
export const tools = [
  {
    name: 'pdf_text',
    description: 'Extract the text of a PDF in the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },

    // args 是模型填的参数；ctx 见下。返回字符串就是模型看到的工具结果。
    async run(args, ctx) {
      const path = String(args.path ?? '');
      ctx.log(`reading ${path}`);
      // ctx.readFile 被限制在工作区内，越界会抛错。
      const size = ctx.readFile(path, 1024).length;
      return `PDF ${path} 前 1KB 有 ${size} 字节。`;
    },
  },
];
```

**关键约定**（写错的话工具不会被加载）：

| 要求 | 原因 |
|---|---|
| 导出名为 `tools` 的数组 | 运行时按这个名字找 |
| 每个工具必须有 `name` 和 `run` 函数 | 没有 `run` 的会被跳过 |
| `name` 不能和内置工具重名 | 防止插件顶掉 `shell` / `fs_write`；重名会被拒绝并记日志 |
| 文件名必须是 `index.mjs` | 没有它，manifest 里声明的工具不会被加载，UI 会标「无实现」 |

## ctx 提供什么

| 方法 | 说明 |
|---|---|
| `ctx.readFile(rel, maxBytes?)` | 读工作区文件。**越界（`../`、绝对路径、指向区外的软链接）会抛错。** |
| `ctx.writeFile(rel, content)` | 写工作区文件，同样受限。目录不存在会自动建。 |
| `ctx.listDir(rel?)` | 列目录，返回 `{name, type, size}`。 |
| `ctx.exec(cmd, {timeoutMs})` | 执行命令。**需要 manifest 里声明 `shell`**，否则返回 code -1 并说明原因。 |
| `ctx.log(msg)` | 写进服务端日志，前缀是插件名。调试用。 |
| `ctx.workspaceRoot` | 当前工作区绝对路径。 |

## 权限：请先读这段

`permissions` 的取值是固定的一套：

| 值 | 含义 |
|---|---|
| `read` | 读工作区文件 |
| `write` | 写工作区文件 |
| `shell` | 执行命令 |
| `network` | 访问网络 |
| `kb` | 读写知识库 |

**这套词表是"声明"，不是"限制"。**

插件代码和 SHE 跑在**同一个进程**里，用的是完整的 Node 权限。所以：

- 声明 `read` 的插件**技术上也能**执行命令 —— 没有任何东西拦着它
- 用户看到的是你**声明**要碰什么，据此决定装不装
- 用一个词表之外的权限（比如 `chat.read`）会被 UI 标成「未知权限」，因为运行时不认它 —— 等于声明了但没生效

这么做不是偷懒。真正的隔离要把插件放进独立进程 + IPC 边界，那是另一个量级的工程；在此之前，**如实说明**比做一个插件可以随手绕过的假沙箱要诚实。这和编辑器扩展的处理方式是一样的。

**所以：插件作者请如实声明，用户请看清再装。**

## 调试

1. **工具不出现** —— 扩展坞里看这条插件的状态：
   - 标「无实现」= 没有 `index.mjs`
   - 有⚠️列表 = 声明有问题（权限词表不对、面板文件缺失）
2. **改了代码没生效** —— 保存会自动重载；如果是手改文件，点扩展坞的 ↻ 重新扫描
3. **看日志** —— 服务端日志里带 `[plugin:你的插件名]` 前缀
4. **`ctx.exec` 返回 -1** —— 忘了声明 `shell` 权限

## 关于工具描述

`description` 是**写给模型看的**，不是写给人看的。模型的工具选择几乎全靠它，所以：

- 说清**什么时候用**（"Use when the user asks about…"），不只说做什么
- 参数用 `description` 说明每个字段的含义和格式
- 描述造假（声明了做不到的事）会让模型反复调用它然后失败

## 面板

manifest 可以声明 `panels`，但**目前只是声明**：运行时不会挂载任意 HTML。声明了却缺少 `entry` 指向的文件，扩展坞会直接报出来，避免出现"看起来有面板其实没有"的插件。

## 现有插件可以参考

仓库 `plugins/` 下有三个官方插件，正好是三种不同复杂度：

| 插件 | 看什么 |
|---|---|
| `workspace-insight` | 最简形态：一个只读工具，遍历工作区做统计 |
| `env-doctor` | 多个 `ctx.exec` 调用、报告式输出、不泄露密钥值的写法 |
| `tunnel` | 长驻进程、`ctx.exec` 不适合时的 `spawn` 用法、安全提示的写法 |
