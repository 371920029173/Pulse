# PERF

Local reproducible baselines for SHE agent-cloud.

> **These are historical measurements (2026-09-12), kept as a record of the method and the shape of
> the numbers — not as current figures.** Two caveats apply when reading them:
>
> - `GET /api/adapters/agi35v2` no longer exists (the adapter was removed; it was never wired into
>   anything), so `perf-tools.json` and the API smoke list below contain one dead row. Re-running the
>   probe will not reproduce it.
> - The listed UI bundle sizes are from that date; the bundle has grown since.
>
> To refresh: run the server, then re-run the probe that produced `.she/perf-smoke.json`.

## API smoke (earlier)
Raw: `.she/perf-smoke.json`

- `at`: `2026-09-12T01:54:43.014Z`
- `base`: `http://127.0.0.1:5577`（或 `SHE_PORT`）
- `results`: `[{'name': 'GET /api/health', 'n': 20, 'min': 0.25, 'p50': 0.37, 'p95': 0.77, 'max': 0.77, 'avg': 0.4}, {'name': 'GET /api/settings', 'n': 20, 'min': 0.23, 'p50': 0.25, 'p95': 0.38, 'max': 0.38, 'avg': 0.26}, {'name': 'GET /api/kb/tree', 'n': 20, 'min': 0.25, 'p50': 0.36, 'p95': 0.68, 'max': 0.68, 'avg': 0.37}, {'name': 'GET /api/fs/tree', 'n': 20, 'min': 1.19, 'p50': 1.3, 'p95': 1.64, 'max': 1.64, 'avg': 1.34}, {'name': 'POST /api/kb/query', 'n': 20, 'min': 0.9, 'p50': 1.07, 'p95': 1.39, 'max': 1.39, 'avg': 1.07}, {'name': 'GET /api/adapters/agi35v2', 'n': 20, 'min': 0.25, 'p50': 0.32, 'p95': 0.63, 'max': 0.63, 'avg': 0.34}, {'name': 'GET /api/fs/checkpoints', 'n': 20, 'min': 0.14, 'p50': 0.17, 'p95': 0.22, 'max': 0.22, 'avg': 0.17}]`
- `burst`: `{'n': 50, 'totalMs': 9.81, 'rps': 5097.3}`

## Tool / UI asset add-on
Raw: `.she/perf-tools.json`

| Endpoint | p50 ms | p95 ms | mean ms |
|---|---:|---:|---:|
| POST /api/terminal/exec (echo) | 25.164 | 32.047 | 21.161 |
| GET /api/fs/suggest?q=pack | 15.966 | 16.271 | 15.561 |
| GET /api/adapters/agi35v2 | 15.932 | 16.204 | 14.337 |
| GET /api/sessions | 15.932 | 16.162 | 15.322 |

UI dist assets:
- `index-DPftYR7f.js`: 190.8 KB
- `index-CRwhtDBk.css`: 36.3 KB

LLM path still blocked by missing API key.
