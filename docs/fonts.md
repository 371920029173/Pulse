# 字体是本地自带的

界面用 **Inter** 和 **JetBrains Mono**。字体文件在 `packages/ui/public/fonts/`（4 个 woff2，
共 172KB），`@font-face` 由 `src/styles/fonts.css` 声明 —— **不连 Google**。

以前不是这样：`index.html` 引用 `fonts.googleapis.com`，每次打开界面都向 Google 发两个请求，
其中一个还是字体文件下载。改成本地自带的原因，按重要性排：

1. **它和应用自己的规则矛盾。** 样式校验器以"会泄露你这台机器在运行本应用"为由拒绝用户的远程
   `@import`，而应用自己每次启动都在做同一件事。只约束用户的规则不算规则。
2. **离线。** 这是本地优先的桌面应用，不该需要网络才能长得像自己。
3. **它不是装饰性的。** 用 `CSS.getPlatformFontsForNode` 实测：在 Windows 10 上界面文字**真的**
   由 `Inter-Bold` 渲染 —— 字体栈里的 `Segoe UI Variable` 只有 Windows 11 有，
   `-apple-system` / `SF Pro Text` 只有 macOS 有，所以 Win10 会一路落到 webfont。
   只删链接而不自带字体，会改变开发机上的实际外观。

只保留 `latin` / `latin-ext` 子集；CJK 字形本来就来自系统字体（Inter 没有 CJK 字形）。
`unicode-range` 原样保留，所以浏览器仍然只下载页面需要的子集 —— 只不过现在是向本机要。

## 维护

加/改字重时跑 `pnpm vendor:fonts`（需要网络）。产物已提交，所以正常构建**不需要网络**。

`pnpm check:dist` 会断言产物里没有任何第三方字体/样式引用，防止哪天又接回去。
