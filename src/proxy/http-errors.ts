import type { Response } from 'express';
import { describeProxyError, InvalidRequestError } from '../core/errors.js';
import { sendAnthropicError } from './anthropic.js';
import { sendOpenAiError } from './openai.js';

export type ErrorProtocol = 'openai' | 'anthropic';

export function sendProxyError(res: Response, error: unknown, protocol: ErrorProtocol = 'openai'): void {
  if (res.headersSent) {
    res.end();
    return;
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
  sendOpenAiError(res, descriptor.status, descriptor.message, descriptor.code);
}

export function invalidJsonError(error: unknown): InvalidRequestError | undefined {
  if (error instanceof SyntaxError) return new InvalidRequestError('JSON inválido.');
  return undefined;
}
