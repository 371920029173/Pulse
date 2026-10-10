# 开发档 · 用 adb 控制手机（读屏 + 点击）

Use when the phone has to be driven (发消息、点确认、装应用、远程操作), or when the user says "直接控制我设备".

## 工具与前置
- `D:\tools\platform-tools\adb.exe`（不在就 `curl -L -o D:\tools\platform-tools.zip https://dl.google.com/android/repository/platform-tools-latest-windows.zip` 再解压 —— **别把工具放进项目目录**，用户明确要求放 D 盘）。
- 插线后 `adb devices -l` 必须是 `device`；`unauthorized` = 手机上还没点"允许 USB 调试"。

## 步骤
1. **多设备一定带 `-s <serial>`**：不带会 `more than one device/emulator`（一次 daemon 重启、开了无线调试都会多出一个）。
2. **读屏当眼睛**（我看不到图，但 UI 树里有文字和坐标）：
   ```
   adb -s <serial> shell uiautomator dump /sdcard/ui.xml
   adb -s <serial> pull /sdcard/ui.xml .she\tmp\ui.xml
   node .she\tmp\ui-text.mjs .she\tmp\ui.xml      # 文字/控件 + bounds + 中点
   ```
3. 动作：`shell input tap X Y`、`shell input text <ASCII>`、`shell input keyevent 4`（返回）。

## 踩过的坑（都真的踩了）
- **adb daemon 会让 shell 任务挂着不退**：第一批命令"没有任何输出"，其实是任务没结束、输出没落回来。每批结尾加 `adb kill-server`，或者用 `shell_wait` 去看。
- **键盘弹出会把整块 UI 上移**：坐标是**那一次 dump** 的，点之前重新 dump（本次因此把发送键点空了一次：y 从 2340 变到 1469）。
- **卡片消息是 WebView**，uiautomator 读不到里面的字（`开发者小助手` 的"应用审批通过"通知就是这样）。
- `input text` 不可靠于非 ASCII；空格要写 `%s`。

## 判据
每一步都是"dump → 找目标 → tap/type → 再 dump 确认"。**不做盲点**：没有当次 dump 里出现的目标，就不点。
