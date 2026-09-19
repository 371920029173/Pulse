
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.SHE_API || 'http://127.0.0.1:4577';
// Relative to the current directory, so the output lands in whichever clone is
// being benchmarked instead of a fixed path on one machine.
const OUT = process.env.SHE_PERF_OUT || path.resolve(process.cwd(), '.she', 'perf-smoke.json');

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const payload = body ? JSON.stringify(body) : null;
    const t0 = performance.now();
    const r = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const ms = performance.now() - t0;
          resolve({
            status: res.statusCode,
            ms,
            bytes: Buffer.concat(chunks).byteLength,
          });
        });
      },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function bench(name, fn, n = 20) {
  const samples = [];
  // warmup
  for (let i = 0; i < 3; i++) await fn();
  for (let i = 0; i < n; i++) {
    const r = await fn();
    samples.push(r.ms);
  }
  samples.sort((a, b) => a - b);
  const pct = (p) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))];
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return {
    name,
    n,
    min: samples[0],
    p50: pct(50),
    p95: pct(95),
    max: samples[samples.length - 1],
    avg,
  };
}

const results = [];
results.push(await bench('GET /api/health', () => req('GET', '/api/health')));
results.push(await bench('GET /api/settings', () => req('GET', '/api/settings')));
results.push(await bench('GET /api/kb/tree', () => req('GET', '/api/kb/tree')));
results.push(await bench('GET /api/fs/tree', () => req('GET', '/api/fs/tree?path=.')));
results.push(
  await bench('POST /api/kb/query', () =>
    req('POST', '/api/kb/query', { query: '@sample-workspace', budget: 8 }),
  ),
);
results.push(await bench('GET /api/fs/checkpoints', () => req('GET', '/api/fs/checkpoints')));

// concurrent burst on health
const burstN = 50;
const t0 = performance.now();
await Promise.all(Array.from({ length: burstN }, () => req('GET', '/api/health')));
const burstMs = performance.now() - t0;

const report = {
  at: new Date().toISOString(),
  base: BASE,
  results: results.map((r) => ({
    ...r,
    min: +r.min.toFixed(2),
    p50: +r.p50.toFixed(2),
    p95: +r.p95.toFixed(2),
    max: +r.max.toFixed(2),
    avg: +r.avg.toFixed(2),
  })),
  burst: { n: burstN, totalMs: +burstMs.toFixed(2), rps: +(burstN / (burstMs / 1000)).toFixed(1) },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log('WROTE', OUT);
