import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const port = Number(process.env.KITT_REVERSE_PROXY_CONTROL_PORT || 2999);
const baseUrl = `http://127.0.0.1:${port}`;

async function control(action, params = {}) {
  const response = await fetch(`${baseUrl}/v1/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, params }),
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`control ${action} failed: ${response.status}`);
  return await response.json();
}

async function linuxChildren(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    return raw.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function linuxPssBytes(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
    const match = /^Pss:\s+(\d+)\s+kB$/m.exec(raw);
    if (match) return Number(match[1]) * 1024;
  } catch {}
  try {
    const raw = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(raw);
    if (match) return Number(match[1]) * 1024;
  } catch {}
  return 0;
}

async function processTree(rootPid) {
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    if (process.platform === 'linux') {
      queue.push(...await linuxChildren(pid));
    }
  }
  let pss = 0;
  if (process.platform === 'linux') {
    for (const pid of seen) pss += await linuxPssBytes(pid);
  }
  return { pids: [...seen], pss_bytes: pss || null };
}

const started = performance.now();
const payload = await control('service.list');
const listLatencyMs = performance.now() - started;
const instances = Array.isArray(payload.instances) ? payload.instances : [];

const uniqueRoots = new Set();
const rows = [];
for (const instance of instances) {
  const service = await processTree(Number(instance.pid));
  const browserHostPid = Number(instance.browserHostPid || 0);
  const browserHost = browserHostPid > 0 && !uniqueRoots.has(browserHostPid)
    ? await processTree(browserHostPid)
    : null;
  uniqueRoots.add(browserHostPid);
  rows.push({
    id: instance.id,
    provider: instance.provider,
    status: instance.status,
    service_pid: instance.pid,
    service_tree: service,
    browser_host_pid: browserHostPid || null,
    browser_host_tree: browserHost
  });
}

let shutdownMs = null;
let stopped = null;
if (process.env.KITT_BENCH_DESTRUCTIVE === '1') {
  const shutdownStarted = performance.now();
  const result = await control('service.stopAll');
  shutdownMs = performance.now() - shutdownStarted;
  stopped = result.stopped;
}

console.log(JSON.stringify({
  service: 'kitt-reverse-proxy',
  benchmark_version: 1,
  platform: process.platform,
  instance_count: instances.length,
  service_list_ms: Number(listLatencyMs.toFixed(3)),
  instances: rows,
  destructive_shutdown_ms: shutdownMs === null ? null : Number(shutdownMs.toFixed(3)),
  stopped
}, null, 2));
