# 自定义样式

界面整个建立在 CSS 变量上，改几个变量就能整体换肤。样式文件是一个**普通 `.css` 文件**，
可以直接用编辑器打开改：

```
~/.she-app/theme.css          ← 你的样式（Windows: C:\Users\<你>\.she-app\theme.css）
~/.she-app/theme.css.prev     ← 上一版，用于一键回退
```

也可以从 **设置 → 自定义样式…**（或 `Ctrl+K` → 「自定义样式（换肤）」）里改：左侧编辑、
右侧是**即时预览**，保存前就能看到效果。

```css
:root {
  --accent: #ff7a59;
  --radius-md: 6px;
  --font-sans: 'JetBrains Mono', monospace;
}

/* 也可以直接针对具体元素 */
aside { width: 260px; }
```

常用变量：`--bg-primary` `--bg-secondary` `--text-primary` `--text-secondary` `--accent`
`--border` `--danger` `--radius-md` `--font-sans` `--text-base` `--fill-control` `--shadow-md`。
完整清单在 `packages/ui/src/styles/global.css` 的 `:root` 里。

在 `:root` 里写的变量**深浅两套主题下都会生效**。这一点是特意做的：应用自己的深色 token 写在
`:root`（优先级 0,1,0），浅色 token 写在 `[data-theme="light"]`（0,1,1）—— 如果照搬，你的
`:root` 会赢在深色、**静默输在浅色**。所以注入时会把 `:root` / `html` 提升为
`:root, html[data-theme]`（同优先级且更靠后，两套都赢）。**磁盘上的文件保持你写的原样**，
不做改写。

## 设了壁纸时哪个变量管哪块

（实测，不是推测）

| 你想要的 | 改哪个 | 为什么 |
|---|---|---|
| 磨砂面板 / 气泡 / 弹窗的底色 | `--bg-secondary` | 磨砂规则读的就是它：`color-mix(in srgb, var(--bg-secondary) 80%, transparent)` |
| 工具调用 / 思维链区块 | `--bg-tertiary` | 同上，70% 透明 + 模糊 |
| 页面底色 | `--bg-primary` | **设了壁纸后看不见** —— 它被壁纸整个盖住了（这是设计，不是 bug） |
| 强调色 / 圆角 / 字体等 | `--accent` `--radius-*` `--font-*` | 与壁纸无关，永远生效 |

反过来说：壁纸下的毛玻璃是刻意的效果，所以它带 `!important`。要完全替换某个表面的
`background`，需要写出同样的优先级：

```css
html[data-bg="image"] [data-surface="panel"] {
  background: rgba(20, 20, 30, 0.9);
}
```

## 容错

这是这个功能的重点，因为样式表是本应用里唯一能让应用没法用的输入。

| 情况 | 处理 |
|---|---|
| 存在会锁死界面的写法（`html { display:none }`、`* { pointer-events:none }`） | 保存前拦下，**指出具体行号和原因**；打字时就会实时提示，不用等到保存 |
| 花括号不匹配 | 拦下 —— 未闭合的规则会吃掉后面全部内容，效果和你写的完全不同 |
| 从远程 `@import` | 拦下 —— 那会泄露你这台机器在运行本应用 |
| 提示类问题（如 `url(http…)`） | 只提示，不拦 |
| 你就是想那么写 | `?force=1` 强制保存，并在返回里标记 `forced: true` |
| 预览 | **作用域隔离**：草稿只作用于预览框。`html { display:none }` 在预览里表现为"小样变白"，**弄不坏编辑器**，所以随时能改回去 |
| 界面真的被弄乱了 | 地址栏加 `?theme=off` 回车，或 `curl -X POST localhost:5577/api/theme/disable`。**两条都不依赖界面**，所以界面看不见时也能用；停用只改开关，内容保留 |
| 保存错了版本 | 「恢复上一版」（`POST /api/theme/revert`），而且这次恢复本身也能再恢复一次 |
| 误点「删除」 | 删除会留一份 `theme.css.prev`，用「恢复上一版」即可找回 |
| 样式文件只读 / 是目录 / 非 UTF-8 / 带 BOM / CRLF | 各有确定行为，**界面照常启动**，见下表 |
| 状态文件损坏 | 隔离留底并回到默认，不会导致界面起不来 |

**文件层面的异常**（样式文件是邀请用户用任何工具去改的，所以"坏"不止"语法错"一种）：

| 情况 | 行为 |
|---|---|
| 只读文件 | 保存**明确失败**，错误信息含路径与原因；原内容不动，绝不假装成功 |
| 路径上是个目录 | 同上，提示"这是一个目录，不是文件" |
| 非 UTF-8 字节（GBK 编辑器写的） | 按替换字符读取，接口不报错 |
| 开头有 BOM（记事本 / PowerShell 写的） | 读取时去掉；选择器判定走 `trim()`，而 U+FEFF 属于 ECMAScript 空白，所以也能认出 |
| CRLF 换行 | 正常解析 |
| 符号链接 | 正常，读到目标内容（dotfiles 管理器可以这么接） |
| 只有空白 | 视为空样式，不报错 |
| 并发多次保存 | 最后一次生效，不会写坏 |
| 200KB 样式表 | 校验约 30ms（编辑器每次按键都要跑） |

样式表放在应用目录（`~/.she-app`）而不是工作区里，和壁纸一致 —— 否则切工作区会**悄悄换肤**。

## 接口与回归

接口：`GET/PUT/DELETE /api/theme`、`POST /api/theme/{validate,disable,enable,revert}`。

回归检查：`pnpm check:theme`（73 项，自起服务；含"停用后内容必须还在"、"强制保存会落盘"、
"只读文件不会假装成功"、"换工作区不换肤"、"200KB 校验 <1s"）。
