import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { logger } from '../logger.js';
import {
  adaptCompletionForLegacyFunctions,
  requestMayReturnToolCalls,
  ToolProtocolError
} from '../mapping/tool-calling.js';
import { ConversationStateConflictError, ManualInterventionRequiredError, UiAutomationError } from '../runtime/ui-executor.js';
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
import {
  completionToOllamaChat,
  completionToOllamaGenerate,
  OllamaChatStreamWriter,
  OllamaGenerateStreamWriter,
  ollamaGenerateBodyToChat,
  ollamaShowResponse,
  ollamaTagsResponse,
  validateOllamaChatBody
} from './ollama.js';

function statusForError(error: unknown): number {
  if (error instanceof ToolProtocolError) return error.source === 'request' ? 400 : 502;
  if (error instanceof ConversationStateConflictError) return 409;
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
  if (error instanceof ToolProtocolError) return error.source === 'request'
    ? 'invalid_tool_request'
    : 'invalid_tool_call';
  if (error instanceof ConversationStateConflictError) return 'conversation_state_conflict';
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

  const openAiDiscoveryHandler = (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'kitt-reverse-proxy',
      version: '3.0.0',
      model: executor.modelId,
      transport: executor.transport,
      endpoints: {
        openai: {
          chat: '/v1/chat/completions',
          models: '/v1/models',
          responses: '/v1/responses'
        },
        ollama: {
          chat: '/api/chat',
          generate: '/api/generate',
          tags: '/api/tags',
          version: '/api/version',
          show: '/api/show'
        },
        status: '/v1/kitt/status',
        capabilities: '/v1/capabilities',
        health: '/healthz'
      },
      capabilities: {
        openai_chat_completions: true,
        openai_responses: true,
        openai_tool_calls: true,
        openai_legacy_functions: true,
        ollama_chat: true,
        ollama_tool_calls: true,
        streaming: true
      }
    });
  };

  app.get('/', (req: Request, res: Response) => {
    if (req.headers.accept?.includes('application/json')) {
      res.json({
        status: 'ok',
        message: 'Ollama is running',
        service: 'kitt-reverse-proxy',
        version: '3.0.0',
        model: executor.modelId,
        transport: executor.transport
      });
      return;
    }
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.send('Ollama is running');
  });

  app.get('/v1', openAiDiscoveryHandler);

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: executor.transport, model: executor.modelId, queueDepth: queue.depth });
  });

  app.get('/v1/models', (_req: Request, res: Response) => {
    res.json({ object: 'list', data: [{ id: executor.modelId, object: 'model', owned_by: 'kitt-reverse-proxy' }] });
  });

  app.get('/v1/models/:model', (req: Request, res: Response) => {
    if (req.params.model !== executor.modelId) {
      sendOpenAiError(res, 404, `Modelo não encontrado: ${req.params.model}`, 'model_not_found');
      return;
    }
    res.json({ id: executor.modelId, object: 'model', owned_by: 'kitt-reverse-proxy' });
  });

  app.get(['/v1/capabilities', '/v1/kitt/capabilities'], (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      transport: executor.transport,
      model: executor.modelId,
      protocols: {
        openai: {
          chat_completions: true,
          responses: true,
          streaming: true,
          tools: true,
          legacy_functions: true,
          parallel_tool_calls: true,
          function_call_output: true,
          function_tools_only: true,
          previous_response_id: false,
          structured_outputs: false
        },
        ollama: {
          chat: true,
          streaming: true,
          tools: true
        }
      },
      semantics: {
        tool_execution: 'client',
        ui_tool_calling: 'protocol-emulated',
        strict_json_schema_enforcement: false,
        conversation_scope: 'one browser conversation per proxy instance'
      }
    });
  });

  app.get('/api/tags', (_req: Request, res: Response) => {
    res.json(ollamaTagsResponse(executor.modelId));
  });

  app.post('/api/show', (req: Request, res: Response) => {
    const model = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : executor.modelId;
    res.json(ollamaShowResponse(model));
  });

  app.get('/api/version', (_req: Request, res: Response) => {
    res.json({ version: '0.5.1' });
  });

  app.get('/api/ps', (_req: Request, res: Response) => {
    res.json(ollamaTagsResponse(executor.modelId));
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
      const bufferTools = requestMayReturnToolCalls(body);
      if (body.stream === true) {
        const model = typeof body.model === 'string' && body.model.trim() ? body.model : executor.modelId;
        const writer = new ChatStreamWriter(res, model);
        const result = await execute(
          body,
          bufferTools ? undefined : { onDelta: (delta) => writer.delta(delta) }
        );
        const completion = adaptCompletionForLegacyFunctions(result.completion, body);
        writer.finish(completion, bufferTools ? [] : result.deltas);
      } else {
        const { completion } = await execute(body);
        res.json(adaptCompletionForLegacyFunctions(completion, body));
      }
    } catch (error) {
      const status = isInvalidRequest(error, 'chat') ? 400 : statusForError(error);
      logger.warn(`chat/completions: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendOpenAiError(res, status, error instanceof Error ? error.message : 'Erro interno.', codeForError(error));
      else res.end();
    }
  });

  app.post('/api/chat', async (req: Request, res: Response) => {
    try {
      const body = validateOllamaChatBody(req.body);
      const model = typeof body.model === 'string' && body.model.trim() ? body.model : executor.modelId;
      if (body.stream === true || body.stream === undefined) {
        const writer = new OllamaChatStreamWriter(res, model);
        const bufferTools = requestMayReturnToolCalls(body);
        const result = await execute(
          body,
          bufferTools ? undefined : { onDelta: (delta) => writer.delta(delta) }
        );
        writer.finish(result.completion);
      } else {
        const { completion } = await execute(body);
        res.json(completionToOllamaChat(completion, model));
      }
    } catch (error) {
      const status = isInvalidRequest(error, 'chat') ? 400 : statusForError(error);
      logger.warn(`api/chat: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendOpenAiError(res, status, error instanceof Error ? error.message : 'Erro interno.', codeForError(error));
      else res.end();
    }
  });

  app.post('/api/generate', async (req: Request, res: Response) => {
    try {
      const chatBody = ollamaGenerateBodyToChat(req.body);
      const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model : executor.modelId;
      if (req.body?.stream === true || req.body?.stream === undefined) {
        const writer = new OllamaGenerateStreamWriter(res, model);
        await execute(chatBody, { onDelta: (delta) => writer.delta(delta) });
        writer.finish();
      } else {
        const { completion } = await execute(chatBody);
        res.json(completionToOllamaGenerate(completion, model));
      }
    } catch (error) {
      const status = isInvalidRequest(error, 'chat') ? 400 : statusForError(error);
      logger.warn(`api/generate: ${error instanceof Error ? error.message : String(error)}`);
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
        const bufferTools = requestMayReturnToolCalls(body);
        const result = await execute(
          body,
          bufferTools ? undefined : { onDelta: (delta) => writer.delta(delta) }
        );
        writer.finish(result.completion, bufferTools ? [] : result.deltas);
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
