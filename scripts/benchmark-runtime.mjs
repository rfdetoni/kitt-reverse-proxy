import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';

const port = Number(process.env.KITT_REVERSE_PROXY_CONTROL_PORT || 2999);
const baseUrl = `http://127.0.0.1:${port}`;
const target = String(process.env.KITT_BENCH_TARGET || '').trim();
const apiKey = String(process.env.KITT_BENCH_API_KEY || process.env.PROXY_API_KEY || '').trim();
const counts = String(process.env.KITT_BENCH_SERVICE_COUNTS || '1,2,4')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 8);

function serviceHeaders(sessionId = '') {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(sessionId ? { 'x-kitt-session-id': sessionId } : {})
  };
}

async function control(action, params = {}) {
  const response = await fetch(`${baseUrl}/v1/control`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({ action, params }),
    signal: AbortSignal.timeout(10_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `control ${action} failed: ${response.status}`);
  }
  return payload;
}

async function controlReady() {
  try {
    const response = await fetch(`${baseUrl}/healthz`, {
      signal: AbortSignal.timeout(500)
    });
    return response.ok;
  } catch {
    return false;
  }
}

if (!await controlReady()) {
  const ensured = spawnSync(
    process.execPath,
    ['dist/cli.js', 'control', 'ensure', '--json'],
    { encoding: 'utf8', env: process.env }
  );
  if (ensured.status !== 0 || !await controlReady()) {
    throw new Error(ensured.stderr || ensured.stdout || 'control ensure failed');
  }
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
    if (process.platform === 'linux') queue.push(...await linuxChildren(pid));
  }
  let pss = 0;
  if (process.platform === 'linux') {
    for (const pid of seen) pss += await linuxPssBytes(pid);
  }
  return { pids: [...seen], pss_bytes: pss || null };
}

async function snapshotInstances() {
  const started = performance.now();
  const payload = await control('service.list');
  const listMs = performance.now() - started;
  const instances = Array.isArray(payload.instances) ? payload.instances : [];
  const hostTrees = new Map();
  const rows = [];
  for (const instance of instances) {
    const serviceTree = await processTree(Number(instance.pid));
    const browserHostPid = Number(instance.browserHostPid || 0);
    let browserHostTree = null;
    if (browserHostPid > 0) {
      if (!hostTrees.has(browserHostPid)) {
        hostTrees.set(browserHostPid, await processTree(browserHostPid));
      }
      browserHostTree = hostTrees.get(browserHostPid);
    }
    rows.push({
      id: instance.id,
      provider: instance.provider,
      status: instance.status,
      service_pid: instance.pid,
      service_tree: serviceTree,
      browser_host_pid: browserHostPid || null,
      browser_host_tree: browserHostTree
    });
  }
  const uniquePids = new Set();
  let totalPss = 0;
  for (const row of rows) {
    for (const pid of row.service_tree.pids) uniquePids.add(pid);
    for (const pid of row.browser_host_tree?.pids || []) uniquePids.add(pid);
  }
  if (process.platform === 'linux') {
    for (const pid of uniquePids) totalPss += await linuxPssBytes(pid);
  }
  return {
    service_list_ms: Number(listMs.toFixed(3)),
    instance_count: instances.length,
    total_unique_processes: uniquePids.size,
    total_pss_bytes: totalPss || null,
    instances: rows
  };
}

async function waitReady(id, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let delay = 100;
  while (Date.now() < deadline) {
    const payload = await control('service.list');
    const instance = (payload.instances || []).find((item) => item.id === id);
    if (instance?.status === 'ready') return instance;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(1_000, Math.ceil(delay * 1.5));
  }
  throw new Error(`service did not become ready: ${id}`);
}

function percentile(samples, ratio) {
  if (!samples.length) return null;
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))];
}

async function browserInspectP95(instance, iterations = 20) {
  const origin = `http://127.0.0.1:${instance.port}`;
  try {
    const opened = await fetch(`${origin}/v1/kitt/browser/open`, {
      method: 'POST',
      headers: serviceHeaders(),
      body: JSON.stringify({ url: `${origin}/healthz` }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!opened.ok) return null;

    const samples = [];
    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      const response = await fetch(`${origin}/v1/kitt/browser/inspect`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: '{}',
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) return null;
      await response.arrayBuffer();
      samples.push(performance.now() - started);
    }
    await fetch(`${origin}/v1/kitt/browser/close`, {
      method: 'POST',
      headers: serviceHeaders(),
      body: '{}',
      signal: AbortSignal.timeout(5_000)
    }).catch(() => undefined);
    return Number(percentile(samples, 0.95).toFixed(3));
  } catch {
    return null;
  }
}

async function namedSessionCreationP95(instance, iterations = 5) {
  const origin = `http://127.0.0.1:${instance.port}`;
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const sessionId = `benchsession${Date.now()}${index}`;
    const started = performance.now();
    try {
      const response = await fetch(`${origin}/v1/kitt/browser/open`, {
        method: 'POST',
        headers: serviceHeaders(sessionId),
        body: JSON.stringify({ url: `${origin}/healthz` }),
        signal: AbortSignal.timeout(30_000)
      });
      if (!response.ok) return null;
      await response.arrayBuffer();
      samples.push(performance.now() - started);

      await fetch(`${origin}/v1/kitt/browser/close`, {
        method: 'POST',
        headers: serviceHeaders(sessionId),
        body: '{}',
        signal: AbortSignal.timeout(10_000)
      }).catch(() => undefined);
      await fetch(`${origin}/v1/kitt/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: serviceHeaders(),
        signal: AbortSignal.timeout(10_000)
      }).catch(() => undefined);
    } catch {
      return null;
    }
  }
  return samples.length ? Number(percentile(samples, 0.95).toFixed(3)) : null;
}

async function managedScenario(count) {
  const nonce = `${process.pid}-${Date.now()}-${count}`;
  const ids = [];
  const profiles = [];
  const startup = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const id = `bench-${nonce}-${index}`;
      const profile = process.env.KITT_BENCH_SHARED_PROFILE === '1'
        ? `bench-${nonce}-shared`
        : `bench-${nonce}-${index}`;
      ids.push(id);
      profiles.push(profile);
      const started = performance.now();
      await control('service.start', { target, id, profile });
      await waitReady(id);
      startup.push(performance.now() - started);
    }

    const snapshot = await snapshotInstances();
    const listed = await control('service.list');
    const benchmarkInstances = (listed.instances || []).filter((item) => ids.includes(item.id));
    const inspect = [];
    const namedSession = [];
    for (const instance of benchmarkInstances) {
      const p95 = await browserInspectP95(instance);
      if (p95 !== null) inspect.push(p95);
      const namedP95 = await namedSessionCreationP95(instance);
      if (namedP95 !== null) namedSession.push(namedP95);
    }

    const shutdownStarted = performance.now();
    for (const id of ids) await control('service.stop', { id });
    const shutdownMs = performance.now() - shutdownStarted;

    return {
      requested_services: count,
      startup_ready_ms: startup.map((value) => Number(value.toFixed(3))),
      startup_ready_p95_ms: startup.length ? Number(percentile(startup, 0.95).toFixed(3)) : null,
      browser_inspect_p95_ms: inspect.length ? Number(percentile(inspect, 0.95).toFixed(3)) : null,
      named_session_create_p95_ms: namedSession.length
        ? Number(percentile(namedSession, 0.95).toFixed(3))
        : null,
      shutdown_ms: Number(shutdownMs.toFixed(3)),
      snapshot
    };
  } finally {
    for (const id of ids) {
      await control('service.stop', { id }).catch(() => undefined);
    }
    for (const profile of [...new Set(profiles)]) {
      await control('profiles.remove', { id: profile, delete_data: true }).catch(() => undefined);
    }
  }
}

const baseline = await snapshotInstances();
const managed = [];
if (target) {
  for (const count of counts.length ? counts : [1, 2, 4]) {
    managed.push(await managedScenario(count));
  }
}

console.log(JSON.stringify({
  service: 'kitt-reverse-proxy',
  benchmark_version: 2,
  platform: process.platform,
  mode: target ? 'managed' : 'snapshot',
  target: target || null,
  baseline,
  managed_scenarios: managed
}, null, 2));
