import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { RESOURCE_LIMITS } from './core/resource-limits.js';
import { currentTraceContext } from './observability/tracing.js';
import { getRequestContext } from './util/request-context.js';

export type LogFormat = 'text' | 'json';
export type LogSink = 'stdout' | 'stderr';
export type LogLevel = 0 | 1 | 2;
export type LogContentPolicy = 'none' | 'metadata' | 'full';

let format: LogFormat = 'text';
let sink: LogSink = 'stdout';
let verbosity: LogLevel = 0;
let contentPolicy: LogContentPolicy = 'metadata';
let filePath: string | undefined;
let fileStream: WriteStream | undefined;
let pendingWrites: Promise<void> = Promise.resolve();

const RESERVED_FIELDS = new Set([
  'timestamp', 'level', 'request_id', 'session_id', 'provider', 'event', 'duration_ms',
  'trace_id', 'span_id', 'message'
]);
const SENSITIVE_FIELD = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|credential|csrf|xsrf)/i;
const CONTENT_FIELD = /(^|_)(prompt|content|body|messages?|response|result|payload|arguments?|html|snapshot|document|raw|text)($|_)/i;
const SAFE_CONTENT_METADATA_SUFFIX = /_(type|length|bytes|chars|count|id|name|status)$/i;

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

function contentSummary(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return { redacted: true, type: 'string', chars: value.length };
  if (Buffer.isBuffer(value)) return { redacted: true, type: 'buffer', bytes: value.length };
  if (Array.isArray(value)) return { redacted: true, type: 'array', items: value.length };
  if (typeof value === 'object') return {
    redacted: true,
    type: 'object',
    keys: Object.keys(value as Record<string, unknown>).length
  };
  return { redacted: true, type: typeof value };
}

function shouldHideContent(key: string): boolean {
  return CONTENT_FIELD.test(key) && !SAFE_CONTENT_METADATA_SUFFIX.test(key);
}

function sanitizeField(value: unknown, key: string, depth: number, full = false): unknown {
  if (SENSITIVE_FIELD.test(key)) return '[REDACTED]';
  if (shouldHideContent(key) && contentPolicy !== 'full') {
    return contentPolicy === 'none' ? '[OMITTED]' : contentSummary(value);
  }
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

function swapFileStream(nextPath: string | undefined): void {
  const previous = fileStream;
  fileStream = undefined;
  filePath = nextPath;
  if (nextPath) {
    mkdirSync(dirname(nextPath), { recursive: true });
    const stream = createWriteStream(nextPath, { flags: 'a', encoding: 'utf8' });
    stream.on('error', () => undefined);
    fileStream = stream;
  }
  if (previous) {
    pendingWrites = pendingWrites.then(() => new Promise<void>((resolve) => {
      previous.end(resolve);
    })).catch(() => undefined);
  }
}

export function configureLogger(options: {
  format?: LogFormat;
  sink?: LogSink;
  level?: LogLevel;
  content?: LogContentPolicy;
  file?: string | undefined;
}): void {
  if (options.format) format = options.format;
  if (options.sink) sink = options.sink;
  if (options.level !== undefined) verbosity = options.level;
  if (options.content) contentPolicy = options.content;
  if (options.file !== undefined) {
    const next = options.file || undefined;
    if (next !== filePath) swapFileStream(next);
  }
}

export function currentLogLevel(): LogLevel {
  return verbosity;
}

export function currentLogContentPolicy(): LogContentPolicy {
  return contentPolicy;
}

function emit(rendered: string): void {
  const output = sink === 'stderr' ? console.error : console.log;
  output(rendered);
  const target = fileStream;
  if (!target) return;
  const accepted = target.write(rendered + '\n', 'utf8');
  if (!accepted) {
    pendingWrites = pendingWrites.then(() => new Promise<void>((resolve) => {
      const done = (): void => {
        target.off('drain', done);
        target.off('error', done);
        resolve();
      };
      target.once('drain', done);
      target.once('error', done);
    })).catch(() => undefined);
  }
}

function write(
  level: string,
  event: string,
  message: string,
  fields: Record<string, unknown> = {},
  full = false
): void {
  const context = getRequestContext();
  const trace = currentTraceContext();
  const cleaned = sanitizeLogMessage(message);
  const safeFields = sanitizeFields(fields, full && contentPolicy === 'full');
  if (format === 'json') {
    emit(JSON.stringify({
      ...safeFields,
      timestamp: new Date().toISOString(),
      level,
      request_id: context?.requestId ?? null,
      session_id: context?.sessionId ?? null,
      provider: context?.provider ?? null,
      trace_id: trace?.traceId ?? null,
      span_id: trace?.spanId ?? null,
      event,
      duration_ms: context ? Math.max(0, Date.now() - context.startedAt) : 0,
      message: cleaned
    }));
    return;
  }
  const prefix = level === 'error' ? '[-]' : level === 'warn' ? '[!]' : level === 'success' ? '[+]' : level === 'debug' ? '[d]' : level === 'trace' ? '[t]' : '[i]';
  const details = verbosity >= 1 && Object.keys(safeFields).length ? ` ${JSON.stringify(safeFields)}` : '';
  emit(`${prefix} ${cleaned}${details}`);
}

export async function flushLogger(): Promise<void> {
  await pendingWrites;
}

export async function closeLogger(): Promise<void> {
  await pendingWrites;
  const stream = fileStream;
  fileStream = undefined;
  filePath = undefined;
  if (!stream) return;
  await new Promise<void>((resolve) => stream.end(resolve));
}

export const logger = Object.freeze({
  step(current: number, total: number, message: string): void {
    if (format === 'json') write('info', 'step', message, { current, total });
    else emit(`[${current}/${total}] ${sanitizeLogMessage(message)}`);
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
