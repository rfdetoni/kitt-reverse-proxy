import { performance } from 'node:perf_hooks';
import { selectorCandidates } from '../dist/runtime/semantic-locator.js';
import { SerialQueue } from '../dist/runtime/serial-queue.js';
import { Telemetry } from '../dist/util/telemetry.js';
import { sanitizeLogMessage } from '../dist/logger.js';

const ITERATIONS = Math.max(1_000, Number(process.env.KITT_BENCH_ITERATIONS || 20_000));

function benchmarkSync(name, operation) {
  const started = performance.now();
  for (let i = 0; i < ITERATIONS; i += 1) operation(i);
  const elapsedMs = performance.now() - started;
  return {
    name,
    iterations: ITERATIONS,
    total_ms: Number(elapsedMs.toFixed(3)),
    avg_us: Number(((elapsedMs * 1000) / ITERATIONS).toFixed(3)),
    ops_per_second: Math.round((ITERATIONS / elapsedMs) * 1000)
  };
}

async function benchmarkQueue() {
  const queue = new SerialQueue(ITERATIONS + 1, 0);
  const started = performance.now();
  for (let i = 0; i < ITERATIONS; i += 1) await queue.run(async () => i);
  const elapsedMs = performance.now() - started;
  return {
    name: 'serial_queue_zero_interval',
    iterations: ITERATIONS,
    total_ms: Number(elapsedMs.toFixed(3)),
    avg_us: Number(((elapsedMs * 1000) / ITERATIONS).toFixed(3)),
    ops_per_second: Math.round((ITERATIONS / elapsedMs) * 1000)
  };
}

const telemetry = new Telemetry();
const results = [
  benchmarkSync('selector_candidate_resolution', () => {
    selectorCandidates(['#prompt-textarea', '[role="textbox"]'], 'composer');
  }),
  benchmarkSync('telemetry_counter', (i) => {
    telemetry.recordRequest('chatgpt', '/v1/chat/completions', i % 5 === 0 ? 500 : 200, i % 100);
  }),
  benchmarkSync('log_url_sanitization', (i) => {
    sanitizeLogMessage(`request ${i} failed https://example.com/chat?token=secret#fragment`);
  }),
  await benchmarkQueue()
];

console.log(JSON.stringify({
  service: 'kitt-reverse-proxy',
  benchmark_version: 1,
  node: process.version,
  iterations: ITERATIONS,
  results
}, null, 2));
