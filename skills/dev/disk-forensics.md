# 开发档 · 磁盘/IO 取证（"机器卡顿、System 暴涨、吃满带宽"）

Use when the user reports disk thrash / stutter / the System process hammering the disk.

## 顺序（先分清是哪一层，再找是谁）
1. **逻辑 IO ≠ 物理 IO**。`Win32_PerfFormattedData_PerfProc_Process` 的 IORead/WriteBytesPersec **把缓存命中、管道、共享内存都算进去** —— 2026-10-08 我就是据此以为"两个 electron 各 3.6 MB/s"，而物理磁盘其实读 0。
2. 物理侧与队列：`node scripts/disk-probe.mjs 10`，或
   `Get-Counter '\PhysicalDisk(_Total)\Disk Read Bytes/sec','\PhysicalDisk(_Total)\Disk Write Bytes/sec','\PhysicalDisk(_Total)\Current Disk Queue Length'`。
3. 排除换页（很常见但不是唯一）：`\Paging File(_Total)\% Usage`、`\Memory\Pages Output/sec`、`Windows:Available MBytes`。
4. **找"谁在写"**（这是关键一步）：
   - `.she/tmp/rewrite-probe.ps1 -Seconds 30`：哪些文件被重写/新增（**含同尺寸重写** —— 整份覆盖与日志轮转都靠它才看得见）。
   - `.she/tmp/rewrite-count.mjs <文件> 40`：每分钟重写几次、写掉多少 MB。
5. 结论要落到具体代码路径，再改：本次 30 秒里唯一被重写的文件是 `.she/sessions.json`（5.35 MB 整份重写），根因是 `saveStateFile()` 每次保存都序列化整个 store，而 `persistHistory()` 有 ~25 个调用点、流式期间每 2 秒一次。修法：内容没变就不写 + 流式落盘 2s→10s（提交 ef2b621）。

## 注意
- **探针脚本一律纯 ASCII**：PowerShell 5.1 读非 ASCII 的 `.ps1` 会乱码并破坏语法，不只是输出难看。
- 用户说"System 进程"时别立刻归因换页：本次可用内存 27/32 GB、page file 0%。
- 工作区落在桌面这类**被索引**的位置时，每次重写还会连带 Windows 搜索索引与杀软重扫 —— 修我们的写放大之外，可以把工作区加进索引排除列表。
