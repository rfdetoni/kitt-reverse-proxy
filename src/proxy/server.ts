import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { RESOURCE_LIMITS } from '../core/resource-limits.js';
import { InvalidRequestError } from '../core/errors.js';
import { logger } from '../logger.js';
import { runWithRequestContext } from '../util/request-context.js';
import { telemetry } from '../util/telemetry.js';
import type { AppConfig, ChatExecutor } from '../types.js';
import { SessionManager } from '../runtime/session-manager.js';
import { apiKeyMiddleware, sendOpenAiError } from './openai.js';
import { createOpenAiRouter } from './openai-router.js';
import { createAnthropicRouter } from './anthropic-router.js';
import { createOllamaRouter } from './ollama-router.js';
import { createManagementRouter } from './management-router.js';
import { sendProxyError } from './http-errors.js';

const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isTrustedBrowserOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function routeLabel(req: Request): string {
  const route = req.route?.path as unknown;
  const path = typeof route === 'string'
    ? route
    : Array.isArray(route) && typeof route[0] === 'string'
      ? route[0]
      : undefined;
  if (path) return `${req.baseUrl || ''}${path}` || '/';
  return 'unmatched';
}

function requestContextMiddleware(manager: SessionManager) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawRequestId = req.get('x-kitt-request-id');
    const requestId = rawRequestId && SAFE_REQUEST_ID.test(rawRequestId) ? rawRequestId : randomUUID();
    res.setHeader('X-Kitt-Request-Id', requestId);

    const sessionId = req.get('x-kitt-session-id') || 'default';
    const startedAt = Date.now();
    res.on('finish', () => {
      telemetry.recordRequest(manager.providerId, routeLabel(req), res.statusCode, Date.now() - startedAt);
    });

    runWithRequestContext({ requestId, sessionId, provider: manager.providerId, startedAt }, () => next());
  };
}

function originMiddleware(req: Request, res: Response, next: NextFunction): void {
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  if (mutating && !isTrustedBrowserOrigin(req.get('origin'))) {
    sendOpenAiError(res, 403, 'Origin não permitida.', 'origin_not_allowed');
    return;
  }
  next();
}

export async function startProxyServer(input: {
  executor?: ChatExecutor;
  manager?: SessionManager;
  config: AppConfig;
}): Promise<Server> {
  const { config } = input;
  const manager = input.manager ?? (input.executor
    ? new SessionManager({ defaultExecutor: input.executor, provider: 'default', config })
    : (() => { throw new Error('startProxyServer requer executor ou manager.'); })());

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.use(requestContextMiddleware(manager));
  app.use(originMiddleware);

  // Liveness contains no runtime/session metadata and intentionally remains unauthenticated.
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  if (config.cors) {
    app.use(cors({
      origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
        const allowed = isTrustedBrowserOrigin(origin);
        callback(allowed ? null : new Error('CORS origin não permitida.'), allowed);
      },
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'content-type', 'authorization', 'x-api-key', 'x-kitt-session-id',
        'x-kitt-request-id', 'x-kitt-reasoning-effort', 'anthropic-version'
      ],
      exposedHeaders: ['x-kitt-request-id', 'x-kitt-structured-output']
    }));
  }

  // Authentication precedes body parsing so unauthenticated callers cannot force JSON allocation.
  app.use(apiKeyMiddleware(config.apiKey));
  app.use(express.json({ limit: RESOURCE_LIMITS.httpRequestBytes, strict: true }));

  app.use(createManagementRouter(manager, config));
  app.use(createOpenAiRouter(manager));
  app.use(createAnthropicRouter(manager));
  app.use(createOllamaRouter(manager));

  app.use((_req, res) => sendOpenAiError(res, 404, 'Endpoint não encontrado.', 'not_found'));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? (error as { status: number }).status
      : undefined;
    if (status === 413) {
      sendOpenAiError(res, 413, 'Body excede o limite permitido.', 'request_too_large');
      return;
    }
    if (error instanceof SyntaxError) {
      sendProxyError(res, new InvalidRequestError('JSON inválido.'));
      return;
    }
    if (error instanceof Error && /^CORS/.test(error.message)) {
      sendOpenAiError(res, 403, 'CORS origin não permitida.', 'cors_not_allowed');
      return;
    }
    logger.event('error', 'proxy.unhandled_error', { error });
    sendProxyError(res, error);
  });

  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
    server.requestTimeout = Math.max(config.uiResponseTimeoutMs, config.upstreamTimeoutMs) + 30_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 1_000;
    server.once('error', reject);
  });
}
