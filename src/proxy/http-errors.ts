import type { Response } from 'express';
import { describeProxyError, InvalidRequestError } from '../core/errors.js';
import { sendAnthropicError } from './anthropic.js';
import { sendOpenAiError } from './openai.js';

export type ErrorProtocol = 'openai' | 'anthropic';

export function sendProxyError(res: Response, error: unknown, protocol: ErrorProtocol = 'openai'): void {
  if (res.headersSent) {
    const descriptor = describeProxyError(error);
    const usage = (error as { usage?: unknown })?.usage;
    const payload = JSON.stringify({ error: { message: descriptor.message, code: descriptor.code, type: 'api_error',
      ...((error as { requestId?: string })?.requestId ? { request_id: (error as { requestId: string }).requestId } : {}),
      ...((error as { outcome?: string })?.outcome ? { outcome: (error as { outcome: string }).outcome } : {}),
      ...(descriptor.recoverable !== undefined ? { recoverable: descriptor.recoverable, recovery_action: descriptor.recoveryAction } : {}) }, ...(usage ? { usage } : {}) });
    if (!res.destroyed && !res.writableEnded && (res.writableLength ?? 0) < 4 * 1024 * 1024) {
      const sse = String(res.getHeader('content-type') ?? '').includes('text/event-stream');
      res.write(sse ? `event: error\ndata: ${payload}\n\n` : `${payload}\n`);
    }
    res.end(); return;
  }
  const descriptor = describeProxyError(error);
  if (protocol === 'anthropic') {
    const type = descriptor.status === 400
      ? 'invalid_request_error'
      : descriptor.status === 429
        ? 'rate_limit_error'
        : 'api_error';
    sendAnthropicError(res, descriptor.status, descriptor.message, type);
    return;
  }
  sendOpenAiError(
    res,
    descriptor.status,
    descriptor.message,
    descriptor.code,
    {
      ...((error as { requestId?: string })?.requestId ? { request_id: (error as { requestId: string }).requestId } : {}),
      ...((error as { outcome?: string })?.outcome ? { outcome: (error as { outcome: string }).outcome } : {}),
      ...((error as { usage?: unknown })?.usage ? { usage: (error as { usage: never }).usage } : {}),
      ...(descriptor.recoverable !== undefined
        ? { recoverable: descriptor.recoverable }
        : {}),
      ...(descriptor.recoveryAction
        ? { recovery_action: descriptor.recoveryAction }
        : {})
    }
  );
}

export function invalidJsonError(error: unknown): InvalidRequestError | undefined {
  if (error instanceof SyntaxError) return new InvalidRequestError('JSON inválido.');
  return undefined;
}

export function parseRequestBody<T>(parser: (value: unknown) => T, value: unknown): T {
  try {
    return parser(value);
  } catch (error) {
    if (error instanceof InvalidRequestError) throw error;
    const descriptor = describeProxyError(error);
    if (descriptor.code !== 'proxy_error') throw error;
    throw new InvalidRequestError(error instanceof Error ? error.message : 'Request inválido.');
  }
}
