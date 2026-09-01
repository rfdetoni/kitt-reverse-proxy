import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { logger } from '../logger.js';
import { ManualInterventionRequiredError, UiAutomationError } from '../runtime/ui-executor.js';
import { UpstreamHttpError, UpstreamRedirectError } from '../runtime/upstream.js';
import { QueueFullError, SerialQueue } from '../runtime/serial-queue.js';
import type { AppConfig, ChatExecutionOptions, ChatExecutor, JsonObject } from '../types.js';
import {
  apiKeyMiddleware,
  ChatStreamWriter,
  completionToResponses,
  ResponsesStreamWriter,
  responsesBodyToChat,
  sendOpenAiError,
  validateChatBody
} from './openai.js';

function statusForError(error: unknown): number {
  if (error instanceof QueueFullError) return 429;
  if (error instanceof ManualInterventionRequiredError) return 503;
  if (error instanceof UiAutomationError) return /em \d+s|timeout|tempo/i.test(error.message) ? 504 : 502;
  if (error instanceof UpstreamRedirectError) return 502;
  if (error instanceof UpstreamHttpError) {
    if (error.status === 429) return 429;
    if (error.status === 401 || error.status === 403) return 502;
    return error.status >= 500 ? 502 : 400;
  }
  return 500;
}

function codeForError(error: unknown): string {
  if (error instanceof QueueFullError) return 'queue_full';
  if (error instanceof ManualInterventionRequiredError) return 'manual_intervention_required';
  if (error instanceof UiAutomationError) return 'ui_automation_error';
  if (error instanceof UpstreamRedirectError) return 'upstream_redirect_blocked';
  if (error instanceof UpstreamHttpError && (error.status === 401 || error.status === 403)) return 'upstream_auth_required';
  if (error instanceof UpstreamHttpError) return 'upstream_error';
  return 'proxy_error';
}

function isInvalidRequest(error: unknown, route: 'chat' | 'responses'): boolean {
  if (!(error instanceof Error)) return false;
  return route === 'chat' ? /Body|messages|mensagem/i.test(error.message) : /Body|input|mensagem/i.test(error.message);
}

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

export async function startProxyServer(input: {
  executor: ChatExecutor;
  config: AppConfig;
}): Promise<Server> {
  const { executor, config } = input;
  const app = express();
  const queue = new SerialQueue(config.maxQueue, config.minIntervalMs);

  app.disable('x-powered-by');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const unsafe = req.method === 'POST'
      || req.method === 'PUT'
      || req.method === 'PATCH'
      || req.method === 'DELETE';
    if (unsafe && !isTrustedBrowserOrigin(req.get('origin'))) {
      sendOpenAiError(res, 403, 'Origin não permitida.', 'origin_not_allowed');
      return;
    }
    next();
  });
  app.use(express.json({ limit: '2mb', strict: true }));
  if (config.cors) {
    app.use(cors({
      origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
        const allowed = isTrustedBrowserOrigin(origin);
        callback(allowed ? null : new Error('CORS origin não permitida.'), allowed);
      }
    }));
  }
  app.use(apiKeyMiddleware(config.apiKey));

  const execute = async (body: JsonObject, options?: ChatExecutionOptions) => queue.run(() => executor.execute(body, options));

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: executor.transport, model: executor.modelId, queueDepth: queue.depth });
  });

  app.get('/v1/models', (_req: Request, res: Response) => {
    res.json({ object: 'list', data: [{ id: executor.modelId, object: 'model', owned_by: 'kitt-reverse-proxy' }] });
  });

  app.get('/v1/kitt/status', (_req: Request, res: Response) => {
    res.json({ ...executor.describe(), queueDepth: queue.depth, model: executor.modelId });
  });

  app.post('/v1/kitt/reset', async (_req: Request, res: Response) => {
    try {
      if (!executor.reset) {
        sendOpenAiError(res, 501, 'O transporte atual não oferece reset de conversa.', 'reset_not_supported');
        return;
      }
      await queue.run(() => executor.reset!());
      res.json({ status: 'ok' });
    } catch (error) {
      logger.warn(`reset: ${error instanceof Error ? error.message : String(error)}`);
      sendOpenAiError(res, statusForError(error), error instanceof Error ? error.message : 'Erro ao resetar conversa.', codeForError(error));
    }
  });

  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      const body = validateChatBody(req.body);
      if (body.stream === true) {
        const model = typeof body.model === 'string' && body.model.trim() ? body.model : executor.modelId;
        const writer = new ChatStreamWriter(res, model);
        const result = await execute(body, { onDelta: (delta) => writer.delta(delta) });
        writer.finish(result.completion, result.deltas);
      } else {
        const { completion } = await execute(body);
        res.json(completion);
      }
    } catch (error) {
      const status = isInvalidRequest(error, 'chat') ? 400 : statusForError(error);
      logger.warn(`chat/completions: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendOpenAiError(res, status, error instanceof Error ? error.message : 'Erro interno.', codeForError(error));
      else res.end();
    }
  });

  app.post('/v1/responses', async (req: Request, res: Response) => {
    try {
      const body = responsesBodyToChat(req.body);
      if (req.body?.stream === true) {
        const model = typeof body.model === 'string' && body.model.trim() ? body.model : executor.modelId;
        const writer = new ResponsesStreamWriter(res, model);
        const result = await execute(body, { onDelta: (delta) => writer.delta(delta) });
        writer.finish(result.completion, result.deltas);
      } else {
        const { completion } = await execute(body);
        res.json(completionToResponses(completion));
      }
    } catch (error) {
      const status = isInvalidRequest(error, 'responses') ? 400 : statusForError(error);
      logger.warn(`responses: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendOpenAiError(res, status, error instanceof Error ? error.message : 'Erro interno.', codeForError(error));
      else res.end();
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    if (error instanceof SyntaxError) { sendOpenAiError(res, 400, 'JSON inválido.', 'invalid_request_error'); return; }
    if (error instanceof Error && /^CORS/.test(error.message)) { sendOpenAiError(res, 403, error.message, 'cors_not_allowed'); return; }
    sendOpenAiError(res, 500, error instanceof Error ? error.message : 'Erro interno do proxy.');
  });

  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
    server.once('error', reject);
  });
}
