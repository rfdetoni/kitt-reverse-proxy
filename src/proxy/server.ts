import cors from 'cors';
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { logger } from '../logger.js';
import { ManualInterventionRequiredError, UiAutomationError } from '../runtime/ui-executor.js';
import { UpstreamHttpError } from '../runtime/upstream.js';
import { QueueFullError, SerialQueue } from '../runtime/serial-queue.js';
import type { AppConfig, ChatExecutor, JsonObject } from '../types.js';
import {
  apiKeyMiddleware,
  completionToResponses,
  responsesBodyToChat,
  sendChatStream,
  sendOpenAiError,
  sendResponsesStream,
  validateChatBody
} from './openai.js';

function statusForError(error: unknown): number {
  if (error instanceof QueueFullError) return 429;
  if (error instanceof ManualInterventionRequiredError) return 503;
  if (error instanceof UiAutomationError) return /em \d+s|timeout|tempo/i.test(error.message) ? 504 : 502;
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
  if (error instanceof UpstreamHttpError) return 'upstream_error';
  return 'proxy_error';
}

function isInvalidRequest(error: unknown, route: 'chat' | 'responses'): boolean {
  if (!(error instanceof Error)) return false;
  return route === 'chat' ? /Body|messages|mensagem/i.test(error.message) : /Body|input|mensagem/i.test(error.message);
}

export async function startProxyServer(input: {
  executor: ChatExecutor;
  config: AppConfig;
}): Promise<Server> {
  const { executor, config } = input;
  const app = express();
  const queue = new SerialQueue(config.maxQueue, config.minIntervalMs);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb', strict: true }));
  if (config.cors) {
    app.use(cors({
      origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
        if (!origin) { callback(null, true); return; }
        try {
          const host = new URL(origin).hostname;
          const allowed = ['127.0.0.1', 'localhost', '::1'].includes(host);
          callback(allowed ? null : new Error('CORS origin não permitida.'), allowed);
        } catch {
          callback(new Error('CORS origin inválida.'));
        }
      }
    }));
  }
  app.use(apiKeyMiddleware(config.apiKey));

  const execute = async (body: JsonObject) => queue.run(() => executor.execute(body));

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
      const { completion, deltas } = await execute(body);
      if (body.stream === true) sendChatStream(res, completion, deltas);
      else res.json(completion);
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
      const { completion, deltas } = await execute(body);
      if (req.body?.stream === true) sendResponsesStream(res, completion, deltas);
      else res.json(completionToResponses(completion));
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
