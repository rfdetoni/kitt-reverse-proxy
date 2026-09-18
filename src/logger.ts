import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RESOURCE_LIMITS } from './core/resource-limits.js';
import { getRequestContext } from './util/request-context.js';

export type LogFormat = 'text' | 'json';
export type LogSink = 'stdout' | 'stderr';
export type LogLevel = 0 | 1 | 2;

let format: LogFormat = 'text';
let sink: LogSink = 'stdout';
let verbosity: LogLevel = 0;
let filePath: string | undefined;

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

function sanitizeField(value: unknown, key: string, depth: number, full = false): unknown {
  if (SENSITIVE_FIELD.test(key)) return '[REDACTED]';
  if (!full && depth >= RESOURCE_LIMITS.structuredLogDepth) return '[MAX_DEPTH]';
  if (typeof value === 'string') return sanitizeLogMessage(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (value instanceof Error) return { name: value.name, message: sanitizeLogMessage(value.message) };
  if (Array.isArray(value)) {
    const items = (full ? value : value.slice(0, RESOURCE_LIMITS.structuredLogArrayItems))
      .map((item) => sanitizeField(item, key, depth + 1, full));
    if (!full && value.length > items.length) items.push(`[TRUNCATED:${value.length - items.length}]`);
    return items;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of (full ? entries : entries.slice(0, RESOURCE_LIMITS.structuredLogObjectKeys))) {
      out[childKey] = sanitizeField(childValue, childKey, depth + 1, full);
    }
    if (!full && entries.length > RESOURCE_LIMITS.structuredLogObjectKeys) {
      out.__truncated__ = entries.length - RESOURCE_LIMITS.structuredLogObjectKeys;
    }
    return out;
  }
  return sanitizeLogMessage(String(value));
}

function sanitizeFields(fields: Record<string, unknown>, full = false): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_FIELDS.has(key)) continue;
    out[key] = sanitizeField(value, key, 0, full);
  }
  return out;
}

export function configureLogger(options: {
  format?: LogFormat;
  sink?: LogSink;
  level?: LogLevel;
  file?: string | undefined;
}): void {
  if (options.format) format = options.format;
  if (options.sink) sink = options.sink;
  if (options.level !== undefined) verbosity = options.level;
  if (options.file !== undefined) {
    filePath = options.file || undefined;
    if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  }
}

export function currentLogLevel(): LogLevel {
  return verbosity;
}

function emit(rendered: string): void {
  const output = sink === 'stderr' ? console.error : console.log;
  output(rendered);
  if (filePath) appendFileSync(filePath, rendered + '\n', { encoding: 'utf8' });
}

function write(
  level: string,
  event: string,
  message: string,
  fields: Record<string, unknown> = {},
  full = false
): void {
  const context = getRequestContext();
  const cleaned = sanitizeLogMessage(message);
  const safeFields = sanitizeFields(fields, full);
  if (format === 'json') {
    emit(JSON.stringify({
      ...safeFields,
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
  const prefix = level === 'error' ? '[-]' : level === 'warn' ? '[!]' : level === 'success' ? '[+]' : level === 'debug' ? '[d]' : level === 'trace' ? '[t]' : '[i]';
  const details = Object.keys(safeFields).length ? ` ${JSON.stringify(safeFields)}` : '';
  emit(`${prefix} ${cleaned}${details}`);
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
  },
  debug(event: string, fields: Record<string, unknown> = {}): void {
    if (verbosity < 1) return;
    write('debug', event, typeof fields.message === 'string' ? fields.message : event, fields);
  },
  trace(event: string, fields: Record<string, unknown> = {}): void {
    if (verbosity < 2) return;
    write('trace', event, typeof fields.message === 'string' ? fields.message : event, fields, true);
  }
});
