import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { SERVICE_NAME, SERVICE_VERSION } from '../version.js';

type AttributeValue = string | number | boolean;
type Attributes = Record<string, AttributeValue | undefined>;

interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: string;
}

interface PendingSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attributes;
  status: { code: 1 | 2; message?: string };
}

const storage = new AsyncLocalStorage<TraceContext>();
const MAX_PENDING_SPANS = 512;
const MAX_BATCH_SPANS = 64;
const FLUSH_DELAY_MS = 100;
const EXPORT_TIMEOUT_MS = 2_000;
const pending: PendingSpan[] = [];
let flushTimer: NodeJS.Timeout | undefined;
let flushPromise: Promise<void> = Promise.resolve();
let dropped = 0;

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function nowNs(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function configuredEndpoint(): string | undefined {
  const raw = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (!url.pathname || url.pathname === '/') url.pathname = '/v1/traces';
    else if (!url.pathname.endsWith('/v1/traces')) url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/traces`;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseTraceparent(value: string | undefined): TraceContext | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return undefined;
  return {
    traceId: match[1]!.toLowerCase(),
    spanId: match[2]!.toLowerCase(),
    traceFlags: match[3]!.toLowerCase()
  };
}

export function currentTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

export function traceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

function otlpValue(value: AttributeValue): Record<string, unknown> {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

function otlpAttributes(attributes: Attributes): Array<Record<string, unknown>> {
  return Object.entries(attributes)
    .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined)
    .slice(0, 64)
    .map(([key, value]) => ({ key, value: otlpValue(value) }));
}

function queueSpan(span: PendingSpan): void {
  if (!configuredEndpoint()) return;
  if (pending.length >= MAX_PENDING_SPANS) {
    dropped += 1;
    return;
  }
  pending.push(span);
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flushPromise = flushPromise.then(() => exportPending()).catch(() => undefined);
    }, FLUSH_DELAY_MS);
    flushTimer.unref();
  }
}

async function exportPending(): Promise<void> {
  const endpoint = configuredEndpoint();
  if (!endpoint || pending.length === 0) return;
  const spans = pending.splice(0, MAX_BATCH_SPANS);
  const droppedNow = dropped;
  dropped = 0;
  if (droppedNow > 0 && spans[0]) spans[0].attributes['kitt.telemetry.dropped_spans'] = droppedNow;

  const payload = {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: SERVICE_NAME } },
          { key: 'service.version', value: { stringValue: SERVICE_VERSION } },
          { key: 'telemetry.sdk.name', value: { stringValue: 'kitt-native-otlp' } }
        ]
      },
      scopeSpans: [{
        scope: { name: 'kitt-reverse-proxy', version: SERVICE_VERSION },
        spans: spans.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: 1,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          attributes: otlpAttributes(span.attributes),
          status: {
            code: span.status.code,
            ...(span.status.message ? { message: span.status.message.slice(0, 256) } : {})
          }
        }))
      }]
    }]
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
  timer.unref();
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch {
    // Observability must never affect request execution.
  } finally {
    clearTimeout(timer);
  }

  if (pending.length > 0) await exportPending();
}

export function beginRequestTrace(
  name: string,
  incomingTraceparent: string | undefined,
  attributes: Attributes,
  operation: (context: TraceContext, finish: (error?: unknown) => void) => void
): void {
  const parent = parseTraceparent(incomingTraceparent);
  const context: TraceContext = {
    traceId: parent?.traceId ?? hex(16),
    spanId: hex(8),
    traceFlags: parent?.traceFlags ?? '01'
  };
  const started = nowNs();
  let finished = false;
  const finish = (error?: unknown): void => {
    if (finished) return;
    finished = true;
    queueSpan({
      traceId: context.traceId,
      spanId: context.spanId,
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name,
      startTimeUnixNano: started,
      endTimeUnixNano: nowNs(),
      attributes,
      status: error
        ? { code: 2, message: error instanceof Error ? error.message : String(error) }
        : { code: 1 }
    });
  };
  storage.run(context, () => operation(context, finish));
}

export async function traceSpan<T>(
  name: string,
  attributes: Attributes,
  operation: () => Promise<T>
): Promise<T> {
  const parent = storage.getStore();
  if (!parent) return operation();
  const context: TraceContext = {
    traceId: parent.traceId,
    spanId: hex(8),
    traceFlags: parent.traceFlags
  };
  const started = nowNs();
  return storage.run(context, async () => {
    try {
      const result = await operation();
      queueSpan({
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: parent.spanId,
        name,
        startTimeUnixNano: started,
        endTimeUnixNano: nowNs(),
        attributes,
        status: { code: 1 }
      });
      return result;
    } catch (error) {
      queueSpan({
        traceId: context.traceId,
        spanId: context.spanId,
        parentSpanId: parent.spanId,
        name,
        startTimeUnixNano: started,
        endTimeUnixNano: nowNs(),
        attributes,
        status: { code: 2, message: error instanceof Error ? error.message : String(error) }
      });
      throw error;
    }
  });
}

export async function flushTracing(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  await flushPromise;
  await exportPending();
}

export function tracingContract(): Record<string, unknown> {
  return {
    enabled: Boolean(configuredEndpoint()),
    protocol: 'otlp/http-json',
    environment: ['OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
    trace_context: 'w3c'
  };
}
