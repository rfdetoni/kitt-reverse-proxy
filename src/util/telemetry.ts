type LabelValue = string | number | boolean;
type Labels = Record<string, LabelValue>;

interface MetricRow {
  labels: Labels;
  value: number;
}

function stableLabelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\u0000');
}

function escapePrometheus(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

class LabeledCounter {
  private readonly values = new Map<string, MetricRow>();

  increment(labels: Labels, amount = 1): void {
    const key = stableLabelKey(labels);
    const previous = this.values.get(key);
    if (previous) {
      previous.value += amount;
      return;
    }
    this.values.set(key, { labels: { ...labels }, value: amount });
  }

  rows(): MetricRow[] {
    return [...this.values.values()]
      .map((row) => ({ labels: { ...row.labels }, value: row.value }))
      .sort((left, right) => stableLabelKey(left.labels).localeCompare(stableLabelKey(right.labels)));
  }

  clear(): void {
    this.values.clear();
  }
}

export interface TelemetrySnapshot {
  requests_total: MetricRow[];
  tool_calls_total: MetricRow[];
  sessions_active: number;
  sessions_created: number;
  sessions_evicted: number;
  parse_failures_total: MetricRow[];
}

export class Telemetry {
  private readonly requests = new LabeledCounter();
  private readonly toolCalls = new LabeledCounter();
  private readonly parseFailures = new LabeledCounter();
  private activeSessions = 0;
  private createdSessions = 0;
  private evictedSessions = 0;

  recordRequest(provider: string, endpoint: string, statusCode: number): void {
    this.requests.increment({ provider, endpoint, status_code: statusCode });
  }

  recordToolCall(provider: string, functionName: string, outcome: 'success' | 'failure' | 'retry'): void {
    this.toolCalls.increment({ provider, function: functionName || 'unknown', outcome });
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
      parse_failures_total: this.parseFailures.rows()
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
      ...snapshot.parse_failures_total.map((row) => this.prometheusRow('parse_failures_total', row))
    ];
    return `${lines.join('\n')}\n`;
  }

  resetForTests(): void {
    this.requests.clear();
    this.toolCalls.clear();
    this.parseFailures.clear();
    this.activeSessions = 0;
    this.createdSessions = 0;
    this.evictedSessions = 0;
  }

  private prometheusRow(name: string, row: MetricRow): string {
    const labels = Object.entries(row.labels)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}="${escapePrometheus(String(value))}"`)
      .join(',');
    return labels ? `${name}{${labels}} ${row.value}` : `${name} ${row.value}`;
  }
}

export const telemetry = new Telemetry();
