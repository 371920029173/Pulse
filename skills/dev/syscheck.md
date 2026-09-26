# 本机 / 开发机检查
适用：端口、进程、磁盘、服务、WSL、日志、环境变量排查。
1. 先确认工作区与 `shell` 沙箱边界；危险命令看是否开启「允许所有命令」。
2. Windows：`Get-NetTCPConnection` / `netstat`、`Get-Process`、`Get-Service`；WSL：`wsl -l -v`。
3. 查 SHE 自身：服务端口（默认 `5577`）、`.env`、`.she/sessions.json`、KB 路径。
4. 结论写入 KB（`kb_upsert`），组路径如 `ops/syscheck/<date>`；弱关联勿升因果。
