import cors from 'cors';
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AdapterProfile, AppConfig, CapturedExchange, JsonObject } from '../types.js';
import { logger } from '../logger.js';
import { DeclarativeAdapter } from '../mapping/engine.js';
import { BrowserUpstreamClient, UpstreamHttpError } from '../runtime/upstream.js';
import { QueueFullError, SerialQueue } from '../runtime/serial-queue.js';
import type { LiveBrowserSession } from '../types.js';
import { apiKeyMiddleware, completionToResponses, responsesBodyToChat, sendOpenAiError, sendSyntheticChatStream, validateChatBody } from './openai.js';

function statusForError(error: unknown): number {
  if (error instanceof QueueFullError) return 429;
  if (error instanceof UpstreamHttpError) {
    if (error.status === 429) return 429;
    if (error.status === 401 || error.status === 403) return 502;
    return error.status >= 500 ? 502 : 400;
  }
  return 500;
}

export async function startProxyServer(input: {
  capture: CapturedExchange;
  session: LiveBrowserSession;
  adapter: DeclarativeAdapter;
  profile: AdapterProfile;
  profileSource: string;
  config: AppConfig;
}): Promise<Server> {
  const { capture, session, adapter, profile, profileSource, config } = input;
  const app = express();
  const queue = new SerialQueue(config.maxQueue, config.minIntervalMs);
  const upstream = new BrowserUpstreamClient(session.context, capture.endpointUrl, capture.headers, config.upstreamTimeoutMs);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb', strict: true }));
  app.use(apiKeyMiddleware(config.apiKey));
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

  const execute = async (body: JsonObject) => queue.run(async () => {
    const mapped = adapter.mapRequest(body);
    const result = await upstream.post(mapped);
    const completion = adapter.mapResponse(result.body, typeof body.model === 'string' ? body.model : config.model);
    adapter.applyState(result.body);
    return completion;
  });

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      targetOrigin: new URL(capture.endpointUrl).origin,
      profileSource,
      stateful: Boolean(profile.state?.updates?.length),
      queueDepth: queue.depth
    });
  });

  app.get('/v1/models', (_req: Request, res: Response) => {
    res.json({ object: 'list', data: [{ id: 'adaptive-web-chat', object: 'model', owned_by: 'local-proxy' }] });
  });

  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      const body = validateChatBody(req.body);
      const completion = await execute(body);
      if (body.stream === true) sendSyntheticChatStream(res, completion);
      else res.json(completion);
    } catch (error) {
      const status = error instanceof Error && /Body|messages/.test(error.message) ? 400 : statusForError(error);
      logger.warn(`chat/completions: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendOpenAiError(res, status, error instanceof Error ? error.message : 'Erro interno.');
      else res.end();
    }
  });

  app.post('/v1/responses', async (req: Request, res: Response) => {
    try {
      if (req.body?.stream === true) {
        sendOpenAiError(res, 400, 'Streaming do endpoint /v1/responses ainda não é suportado; use stream=false.', 'unsupported_streaming');
        return;
      }
      const body = responsesBodyToChat(req.body);
      const completion = await execute(body);
      res.json(completionToResponses(completion));
    } catch (error) {
      const status = error instanceof Error && /Body|input/.test(error.message) ? 400 : statusForError(error);
      logger.warn(`responses: ${error instanceof Error ? error.message : String(error)}`);
      sendOpenAiError(res, status, error instanceof Error ? error.message : 'Erro interno.');
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    if (error instanceof SyntaxError) { sendOpenAiError(res, 400, 'JSON inválido.', 'invalid_request_error'); return; }
    sendOpenAiError(res, 500, error instanceof Error ? error.message : 'Erro interno do proxy.');
  });

  return await new Promise<Server>((resolve, reject) => {
    const server = app.listen(config.port, config.host, () => resolve(server));
    server.once('error', reject);
  });
}
