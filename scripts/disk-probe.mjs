/**
 * Which process is hammering the disk?
 *
 * Samples per-process I/O counters over an interval and reports the DELTA, because the
 * cumulative counters on their own say nothing about what is happening now — a process
 * that read 10 GB an hour ago and nothing since looks identical to one reading
 * continuously.
 *
 *   node scripts/disk-probe.mjs [seconds]
 */
import { execFileSync } from 'node:child_process';

const SECONDS = Number(process.argv[2]) || 12;

/*
 * Windows only: the per-process I/O counters come from PowerShell's
 * `Get-Counter` performance counters, which have no direct equivalent here for
 * macOS/Linux. Reported clearly rather than failing with a spawn error — the tool is
 * genuinely useful on the platform it supports, and useless (not broken) elsewhere.
 */
if (process.platform !== 'win32') {
  console.error(`本工具依赖 Windows 性能计数器（Get-Counter），当前平台 ${process.platform} 不受支持。`);
  console.error('macOS/Linux 上可用 iotop / iostat 观察磁盘活动。');
  process.exit(1);
}

/** Per-process I/O counters, from the OS. */
function sample() {
  /*
   * Windows only — the whole file exits early on other platforms (see the guard at the
   * top). The per-line check cannot see a file-level guard, so it is noted here.
   * portability-check:allow
   */
  const ps = `
    Get-Process | Where-Object { $_.Id -gt 0 } | ForEach-Object {
      $p = $_
      try {
        [PSCustomObject]@{
          Name = $p.ProcessName
          Id = $p.Id
          Read = [double]$p.ReadOperationCount
          Write = [double]$p.WriteOperationCount
          ReadBytes = [double]$p.ReadTransferCount
          WriteBytes = [double]$p.WriteTransferCount
        }
      } catch {}
    } | ConvertTo-Json -Compress
  `;
  // portability-check:allow — the file exits early on non-Windows platforms.
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  const parsed = JSON.parse(raw);
  return new Map((Array.isArray(parsed) ? parsed : [parsed]).map((p) => [p.Id, p]));
}

const fmtBytes = (n) => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n.toFixed(0)} B`;
};

console.log(`\n采样 ${SECONDS} 秒的磁盘 I/O 增量（按字节排序）…\n`);
const before = sample();

// Sample total disk throughput at the same time, for context.
const totalBefore = sample();

await new Promise((r) => setTimeout(r, SECONDS * 1000));
const after = sample();
void totalBefore;

/** Aggregate by process NAME: Cursor runs a dozen processes and per-PID rows are noise. */
const byName = new Map();
for (const [id, a] of after) {
  const b = before.get(id);
  if (!b) continue; // started during the sample
  const readBytes = a.ReadBytes - b.ReadBytes;
  const writeBytes = a.WriteBytes - b.WriteBytes;
  const readOps = a.Read - b.Read;
  const writeOps = a.Write - b.Write;
  if (readBytes <= 0 && writeBytes <= 0 && readOps <= 0 && writeOps <= 0) continue;

  const entry = byName.get(a.Name) ?? { name: a.Name, readBytes: 0, writeBytes: 0, readOps: 0, writeOps: 0, procs: 0 };
  entry.readBytes += readBytes;
  entry.writeBytes += writeBytes;
  entry.readOps += readOps;
  entry.writeOps += writeOps;
  entry.procs++;
  byName.set(a.Name, entry);
}

const rows = [...byName.values()].sort((x, y) => (y.readBytes + y.writeBytes) - (x.readBytes + x.writeBytes));

if (rows.length === 0) {
  console.log('  这段时间内没有任何进程报告 I/O 增量。');
  console.log('  （Windows 有时不更新这些计数器；可以改用 Resource Monitor 看磁盘活动。）');
} else {
  console.log('  进程                          读          写       读次数     写次数  进程数');
  for (const r of rows.slice(0, 20)) {
    console.log(
      `  ${r.name.padEnd(26)} ${fmtBytes(r.readBytes).padStart(10)} ${fmtBytes(r.writeBytes).padStart(11)} `
      + `${String(r.readOps).padStart(9)} ${String(r.writeOps).padStart(9)} ${String(r.procs).padStart(6)}`,
    );
  }
}

console.log('\n=== 全局磁盘队列与吞吐（同一时刻）===');
try {
  // portability-check:allow — the file exits early on non-Windows platforms.
  const counters = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $s = Get-Counter -Counter '\\PhysicalDisk(_Total)\\Disk Read Bytes/sec','\\PhysicalDisk(_Total)\\Disk Write Bytes/sec','\\PhysicalDisk(_Total)\\Current Disk Queue Length' -MaxSamples 3 -SampleInterval 1 -ErrorAction SilentlyContinue
    if ($s) { $s.CounterSamples | Group-Object Path | ForEach-Object { "{0} = {1:N0}" -f $_.Name, (($_.Group | Measure-Object CookedValue -Average).Average) } }
  `], { encoding: 'utf8', timeout: 40_000, windowsHide: true });
  for (const line of counters.trim().split('\n')) {
    const t = line.trim();
    if (t) console.log(`  ${t}`);
  }
} catch (err) {
  console.log(`  取不到性能计数器: ${err.message.slice(0, 120)}`);
}

console.log('');
