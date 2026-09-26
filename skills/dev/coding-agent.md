# 开发档 · Coding agent

Use when skill profile is **dev** or the user is building/debugging software, inspecting a machine, or running repos.

## Bias
- Prefer concrete file paths, commands, diffs, and reproduction steps.
- Inspect before editing; keep changes small and reversible.
- Use sandbox tools: fs_*, grep, shell, git_*, apply/diff, checkpoints.
- For Windows: note cmd vs PowerShell; avoid destroying user data.

## Machine check
1. Confirm workspace root and git status first.
2. Health: API/UI 同端口 5577（静态壳）, disk paths under workspace root
3. Summarize findings as checklist + next action.

## Dual-track
- Product: D:\AGI\she-agent-cloud
- Thin stack D:\AGI\AGI-use — do not merge unless asked.
- Never modify project directories other than the current workspace.

相关：同目录 `syscheck.md` 做本机排查。

## 计划（自动化开时）
- 超过 3 步的改动先 `plan_create`，每步写清怎么验收（跑测试 / `lsp_diagnostics`）。
- 一步验收过了就 `plan_update` 标 done，直接做下一步；不要做完一步就停下来汇报。
- 卡住标 blocked 并写原因；需要用户拍板的步骤建计划时就标 `on_failure: ask`。
