import { RESOURCE_LIMITS } from '../core/resource-limits.js';

type LabelValue = string | number | boolean;
type Labels = Record<string, LabelValue>;

interface MetricRow {
  labels: Labels;
  value: number;
}

interface HistogramRow {
  labels: Labels;
  count: number;
  sum: number;
  buckets: number[];
}

const LATENCY_BUCKETS_MS = Object.freeze([5, 25, 100, 250, 500, 1_000, 2_500, 5_000, 15_000, 30_000, 120_000]);

function stableLabelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\u0000');
}

function escapePrometheus(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function boundedLabel(value: string, fallback = 'unknown'): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || !/^[A-Za-z0-9_./:-]+$/.test(trimmed)) return fallback;
  return trimmed;
}

class BoundedCounter {
  private readonly values = new Map<string, MetricRow>();
  private overflow = 0;

  constructor(private readonly maxSeries = RESOURCE_LIMITS.telemetrySeriesPerMetric) {}

  increment(labels: Labels, amount = 1): void {
    const key = stableLabelKey(labels);
    const previous = this.values.get(key);
    if (previous) {
      previous.value += amount;
      return;
    }
    if (this.values.size >= this.maxSeries) {
      this.overflow += amount;
      return;
    }
    this.values.set(key, { labels: { ...labels }, value: amount });
  }

  rows(): MetricRow[] {
    const rows = [...this.values.values()].map((row) => ({ labels: { ...row.labels }, value: row.value }));
    if (this.overflow > 0) rows.push({ labels: { overflow: true }, value: this.overflow });
    return rows.sort((left, right) => stableLabelKey(left.labels).localeCompare(stableLabelKey(right.labels)));
  }

  clear(): void {
    this.values.clear();
    this.overflow = 0;
  }
}

class BoundedHistogram {
  private readonly values = new Map<string, HistogramRow>();
  private overflow: HistogramRow | undefined;

  constructor(
    private readonly bounds: readonly number[],
    private readonly maxSeries = RESOURCE_LIMITS.telemetrySeriesPerMetric
  ) {}

  observe(labels: Labels, value: number): void {
    const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
    const key = stableLabelKey(labels);
    let row = this.values.get(key);
    if (!row) {
      if (this.values.size >= this.maxSeries) {
        this.overflow ??= { labels: { overflow: true }, count: 0, sum: 0, buckets: this.bounds.map(() => 0) };
        row = this.overflow;
      } else {
        row = { labels: { ...labels }, count: 0, sum: 0, buckets: this.bounds.map(() => 0) };
        this.values.set(key, row);
      }
    }
    row.count += 1;
    row.sum += safeValue;
    for (let index = 0; index < this.bounds.length; index += 1) {
      if (safeValue <= this.bounds[index]!) row.buckets[index]! += 1;
    }
  }

  rows(): HistogramRow[] {
    const rows = [...this.values.values()].map((row) => ({
      labels: { ...row.labels }, count: row.count, sum: row.sum, buckets: [...row.buckets]
    }));
    if (this.overflow) rows.push({
      labels: { ...this.overflow.labels }, count: this.overflow.count, sum: this.overflow.sum, buckets: [...this.overflow.buckets]
    });
    return rows.sort((left, right) => stableLabelKey(left.labels).localeCompare(stableLabelKey(right.labels)));
  }

  clear(): void {
    this.values.clear();
    this.overflow = undefined;
  }
}

export interface TelemetrySnapshot {
  requests_total: MetricRow[];
  tool_calls_total: MetricRow[];
  sessions_active: number;
  sessions_created: number;
  sessions_evicted: number;
  parse_failures_total: MetricRow[];
  request_duration_ms: HistogramRow[];
  queue_wait_ms: HistogramRow[];
}

export class Telemetry {
  private readonly requests = new BoundedCounter();
  private readonly toolCalls = new BoundedCounter();
  private readonly parseFailures = new BoundedCounter();
  private readonly requestDuration = new BoundedHistogram(LATENCY_BUCKETS_MS);
  private readonly queueWait = new BoundedHistogram(LATENCY_BUCKETS_MS);
  private readonly functionLabels = new Set<string>();
  private activeSessions = 0;
  private createdSessions = 0;
  private evictedSessions = 0;

  recordRequest(provider: string, endpoint: string, statusCode: number, durationMs = 0): void {
    const labels = {
      provider: boundedLabel(provider),
      endpoint: boundedLabel(endpoint, 'unknown_route'),
      status_code: Math.trunc(statusCode)
    };
    this.requests.increment(labels);
    this.requestDuration.observe({ provider: labels.provider, endpoint: labels.endpoint }, durationMs);
  }

  recordQueueWait(provider: string, durationMs: number): void {
    this.queueWait.observe({ provider: boundedLabel(provider) }, durationMs);
  }

  recordToolCall(provider: string, functionName: string, outcome: 'success' | 'failure' | 'retry'): void {
    let functionLabel = boundedLabel(functionName);
    if (!this.functionLabels.has(functionLabel)) {
      if (this.functionLabels.size >= RESOURCE_LIMITS.telemetryFunctionLabels) functionLabel = '__other__';
      else this.functionLabels.add(functionLabel);
    }
    this.toolCalls.increment({ provider: boundedLabel(provider), function: functionLabel, outcome });
  }

  recordParseFailure(layer: 'json' | 'codeblock' | 'regex' | 'rejected'): void {
    this.parseFailures.increment({ layer });
  }

  sessionCreated(): void {
    this.createdSessions += 1;
    this.activeSessions += 1;
  }

  sessionEvicted(): void {
    this.evictedSessions += 1;
    this.activeSessions = Math.max(0, this.activeSessions - 1);
  }

  setSessionsActive(value: number): void {
    this.activeSessions = Math.max(0, Math.trunc(value));
  }

  snapshot(): TelemetrySnapshot {
    return {
      requests_total: this.requests.rows(),
      tool_calls_total: this.toolCalls.rows(),
      sessions_active: this.activeSessions,
      sessions_created: this.createdSessions,
      sessions_evicted: this.evictedSessions,
      parse_failures_total: this.parseFailures.rows(),
      request_duration_ms: this.requestDuration.rows(),
      queue_wait_ms: this.queueWait.rows()
    };
  }

  prometheus(): string {
    const snapshot = this.snapshot();
    const lines: string[] = [
      '# TYPE requests_total counter',
      ...snapshot.requests_total.map((row) => this.prometheusRow('requests_total', row)),
      '# TYPE tool_calls_total counter',
      ...snapshot.tool_calls_total.map((row) => this.prometheusRow('tool_calls_total', row)),
      '# TYPE sessions_active gauge',
      `sessions_active ${snapshot.sessions_active}`,
      '# TYPE sessions_created counter',
      `sessions_created ${snapshot.sessions_created}`,
      '# TYPE sessions_evicted counter',
      `sessions_evicted ${snapshot.sessions_evicted}`,
      '# TYPE parse_failures_total counter',
      ...snapshot.parse_failures_total.map((row) => this.prometheusRow('parse_failures_total', row)),
      '# TYPE request_duration_ms histogram',
      ...this.prometheusHistogram('request_duration_ms', snapshot.request_duration_ms),
      '# TYPE queue_wait_ms histogram',
      ...this.prometheusHistogram('queue_wait_ms', snapshot.queue_wait_ms)
    ];
    return `${lines.join('\n')}\n`;
  }

  resetForTests(): void {
    this.requests.clear();
    this.toolCalls.clear();
    this.parseFailures.clear();
    this.requestDuration.clear();
    this.queueWait.clear();
    this.functionLabels.clear();
    this.activeSessions = 0;
    this.createdSessions = 0;
    this.evictedSessions = 0;
  }

  private prometheusRow(name: string, row: MetricRow): string {
    return `${name}${this.labels(row.labels)} ${row.value}`;
  }

  private prometheusHistogram(name: string, rows: HistogramRow[]): string[] {
    const lines: string[] = [];
    for (const row of rows) {
      for (let index = 0; index < LATENCY_BUCKETS_MS.length; index += 1) {
        lines.push(`${name}_bucket${this.labels({ ...row.labels, le: LATENCY_BUCKETS_MS[index]! })} ${row.buckets[index]}`);
      }
      lines.push(`${name}_bucket${this.labels({ ...row.labels, le: '+Inf' })} ${row.count}`);
      lines.push(`${name}_sum${this.labels(row.labels)} ${row.sum}`);
      lines.push(`${name}_count${this.labels(row.labels)} ${row.count}`);
    }
    return lines;
  }

  private labels(labels: Labels): string {
    const value = Object.entries(labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${key}="${escapePrometheus(String(item))}"`)
      .join(',');
    return value ? `{${value}}` : '';
  }
}

export const telemetry = new Telemetry();
