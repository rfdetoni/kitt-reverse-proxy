import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const port = Number(process.env.KITT_REVERSE_PROXY_CONTROL_PORT || 2999);
const baseUrl = `http://127.0.0.1:${port}`;
const samples = Math.max(5, Number(process.env.KITT_BENCH_CONTROL_ITERATIONS || 50));

async function ready() {
  try {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(250) });
    return response.ok;
  } catch {
    return false;
  }
}

const existed = await ready();
const coldStarted = performance.now();
const ensured = spawnSync(
  process.execPath,
  ['dist/cli.js', 'control', 'ensure', '--json'],
  { encoding: 'utf8', env: process.env }
);
const coldMs = performance.now() - coldStarted;
if (ensured.status !== 0) {
  throw new Error(ensured.stderr || ensured.stdout || 'control ensure failed');
}

const latencies = [];
for (let index = 0; index < samples; index += 1) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'plugins.list' })
  });
  if (!response.ok) throw new Error(`control request failed: ${response.status}`);
  await response.arrayBuffer();
  latencies.push(performance.now() - started);
}
latencies.sort((a, b) => a - b);
const percentile = (ratio) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * ratio))];

console.log(JSON.stringify({
  service: 'kitt-reverse-proxy',
  benchmark_version: 1,
  control_server_preexisting: existed,
  cold_ensure_ms: Number(coldMs.toFixed(3)),
  warm_requests: samples,
  warm_p50_ms: Number(percentile(0.50).toFixed(3)),
  warm_p95_ms: Number(percentile(0.95).toFixed(3)),
  warm_p99_ms: Number(percentile(0.99).toFixed(3)),
  client_rss_bytes: process.memoryUsage().rss
}, null, 2));

if (!existed) {
  spawnSync(process.execPath, ['dist/cli.js', 'control', 'stop', '--json'], {
    encoding: 'utf8',
    env: process.env
  });
}
