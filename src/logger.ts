import { RESOURCE_LIMITS } from './core/resource-limits.js';
import { getRequestContext } from './util/request-context.js';

export type LogFormat = 'text' | 'json';
export type LogSink = 'stdout' | 'stderr';

let format: LogFormat = 'text';
let sink: LogSink = 'stdout';

const RESERVED_FIELDS = new Set([
  'timestamp', 'level', 'request_id', 'session_id', 'provider', 'event', 'duration_ms', 'message'
]);
const SENSITIVE_FIELD = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|credential|csrf|xsrf)/i;

function stripSensitiveUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const hadSensitiveTail = Boolean(url.search || url.hash);
    url.search = '';
    url.hash = '';
    const clean = url.toString();
    return hadSensitiveTail ? `${clean}?[redacted]` : clean;
  } catch {
    return raw;
  }
}

export function safeUrlForLog(raw: string): string {
  return stripSensitiveUrl(raw);
}

export function sanitizeLogMessage(message: string): string {
  return String(message).replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
    const trailing = match.match(/[),.;:]+$/)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    return `${stripSensitiveUrl(url)}${trailing}`;
  });
}

function sanitizeField(value: unknown, key: string, depth: number): unknown {
  if (SENSITIVE_FIELD.test(key)) return '[REDACTED]';
  if (depth >= RESOURCE_LIMITS.structuredLogDepth) return '[MAX_DEPTH]';
  if (typeof value === 'string') return sanitizeLogMessage(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (value instanceof Error) return { name: value.name, message: sanitizeLogMessage(value.message) };
  if (Array.isArray(value)) {
    const items = value.slice(0, RESOURCE_LIMITS.structuredLogArrayItems)
      .map((item) => sanitizeField(item, key, depth + 1));
    if (value.length > items.length) items.push(`[TRUNCATED:${value.length - items.length}]`);
    return items;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of entries.slice(0, RESOURCE_LIMITS.structuredLogObjectKeys)) {
      out[childKey] = sanitizeField(childValue, childKey, depth + 1);
    }
    if (entries.length > RESOURCE_LIMITS.structuredLogObjectKeys) {
      out.__truncated__ = entries.length - RESOURCE_LIMITS.structuredLogObjectKeys;
    }
    return out;
  }
  return sanitizeLogMessage(String(value));
}

function sanitizeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_FIELDS.has(key)) continue;
    out[key] = sanitizeField(value, key, 0);
  }
  return out;
}

export function configureLogger(options: { format?: LogFormat; sink?: LogSink }): void {
  if (options.format) format = options.format;
  if (options.sink) sink = options.sink;
}

function write(level: string, event: string, message: string, fields: Record<string, unknown> = {}): void {
  const context = getRequestContext();
  const output = sink === 'stderr' ? console.error : console.log;
  const cleaned = sanitizeLogMessage(message);
  if (format === 'json') {
    output(JSON.stringify({
      ...sanitizeFields(fields),
      timestamp: new Date().toISOString(),
      level,
      request_id: context?.requestId ?? null,
      session_id: context?.sessionId ?? null,
      provider: context?.provider ?? null,
      event,
      duration_ms: context ? Math.max(0, Date.now() - context.startedAt) : 0,
      message: cleaned
    }));
    return;
  }
  const prefix = level === 'error' ? '[-]' : level === 'warn' ? '[!]' : level === 'success' ? '[+]' : '[i]';
  output(`${prefix} ${cleaned}`);
}

export const logger = Object.freeze({
  step(current: number, total: number, message: string): void {
    if (format === 'json') write('info', 'step', message, { current, total });
    else (sink === 'stderr' ? console.error : console.log)(`[${current}/${total}] ${sanitizeLogMessage(message)}`);
  },
  success(message: string): void { write('success', 'success', message); },
  info(message: string): void { write('info', 'info', message); },
  warn(message: string): void { write('warn', 'warning', message); },
  error(message: string): void { write('error', 'error', message); },
  event(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
    write(level, event, typeof fields.message === 'string' ? fields.message : event, fields);
  }
});
