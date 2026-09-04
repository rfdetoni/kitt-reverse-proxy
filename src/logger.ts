import { getRequestContext } from './util/request-context.js';

export type LogFormat = 'text' | 'json';
export type LogSink = 'stdout' | 'stderr';

let format: LogFormat = 'text';
let sink: LogSink = 'stdout';

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
  return message.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
    const trailing = match.match(/[),.;:]+$/)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    return `${stripSensitiveUrl(url)}${trailing}`;
  });
}

function clean(message: string): string {
  return sanitizeLogMessage(String(message));
}

export function configureLogger(options: { format?: LogFormat; sink?: LogSink }): void {
  if (options.format) format = options.format;
  if (options.sink) sink = options.sink;
}

function write(level: string, event: string, message: string, fields: Record<string, unknown> = {}): void {
  const context = getRequestContext();
  const output = sink === 'stderr' ? console.error : console.log;
  const cleaned = clean(message);
  if (format === 'json') {
    output(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      request_id: context?.requestId ?? null,
      session_id: context?.sessionId ?? null,
      provider: context?.provider ?? null,
      event,
      duration_ms: context ? Math.max(0, Date.now() - context.startedAt) : 0,
      message: cleaned,
      ...fields
    }));
    return;
  }
  const prefix = level === 'error' ? '[-]' : level === 'warn' ? '[!]' : level === 'success' ? '[+]' : '[i]';
  output(`${prefix} ${cleaned}`);
}

export const logger = Object.freeze({
  step(current: number, total: number, message: string): void {
    if (format === 'json') write('info', 'step', message, { current, total });
    else (sink === 'stderr' ? console.error : console.log)(`[${current}/${total}] ${clean(message)}`);
  },
  success(message: string): void {
    write('success', 'success', message);
  },
  info(message: string): void {
    write('info', 'info', message);
  },
  warn(message: string): void {
    write('warn', 'warning', message);
  },
  error(message: string): void {
    write('error', 'error', message);
  },
  event(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
    write(level, event, typeof fields.message === 'string' ? fields.message : event, fields);
  }
});
