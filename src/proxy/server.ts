import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { logger } from '../logger.js';
import {
  adaptCompletionForLegacyFunctions,
  requestMayReturnToolCalls,
  ToolProtocolError
} from '../mapping/tool-calling.js';
import {
  ConversationStateConflictError,
  ManualInterventionRequiredError,
  UiAutomationError
} from '../runtime/ui-executor.js';
import { UpstreamHttpError, UpstreamRedirectError } from '../runtime/upstream.js';
import { QueueFullError } from '../runtime/serial-queue.js';
import {
  SessionManager,
  SessionLimitExceededError,
  InvalidSessionIdError,
  SessionNotSupportedError
} from '../runtime/session-manager.js';
import { ProviderNoImageSupportError, ImageInputError } from '../runtime/multimodal.js';
import { ToolParseFailedError } from '../runtime/tool-response.js';
import { ToolEnforcementError } from '../runtime/tool-enforcement.js';
import { runWithRequestContext } from '../util/request-context.js';
import { telemetry } from '../util/telemetry.js';
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
  AnthropicStreamWriter,
  anthropicBodyToChat,
  completionToAnthropic,
  sendAnthropicError
} from './anthropic.js';
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

const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function statusForError(error: unknown): number {
  if (error instanceof SessionLimitExceededError) return 429;
  if (error instanceof InvalidSessionIdError || error instanceof SessionNotSupportedError) return 400;
  if (error instanceof ProviderNoImageSupportError || error instanceof ImageInputError) return 400;
  if (error instanceof ToolEnforcementError || error instanceof ToolParseFailedError) return 502;
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
  if (error instanceof SessionLimitExceededError) return 'session_limit_exceeded';
  if (error instanceof InvalidSessionIdError) return 'invalid_session_id';
  if (error instanceof SessionNotSupportedError) return 'session_not_supported';
  if (error instanceof ProviderNoImageSupportError) return 'provider_no_image_support';
  if (error instanceof ImageInputError) return 'image_input_error';
  if (error instanceof ToolEnforcementError) return 'tool_required_but_not_called';
  if (error instanceof ToolParseFailedError) return 'tool_parse_failed';
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
  executor?: ChatExecutor;
  manager?: SessionManager;
  config: AppConfig;
}): Promise<Server> {
  const { config } = input;
  const manager = input.manager ?? (input.executor ? new SessionManager({
    defaultExecutor: input.executor,
    provider: 'default',
    config
  }) : (() => { throw new Error('startProxyServer requer executor ou manager.'); })());
  const app = express();

  app.disable('x-powered-by');

  app.use((req: Request, res: Response, next: NextFunction) => {
    const rawRequestId = req.get('x-kitt-request-id');
    const requestId = rawRequestId && SAFE_REQUEST_ID.test(rawRequestId) ? rawRequestId : randomUUID();
    res.setHeader('X-Kitt-Request-Id', requestId);

    const sessionId = req.get('x-kitt-session-id') || 'default';
    const startedAt = Date.now();

    res.on('finish', () => {
      const endpoint = req.baseUrl || req.path || 'unknown';
      telemetry.recordRequest(manager.transport, endpoint, res.statusCode);
    });

    runWithRequestContext({
      requestId,
      sessionId,
      provider: manager.transport,
      startedAt
    }, () => next());
  });

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

  const execute = async (sessionId: string | undefined, body: JsonObject, options?: ChatExecutionOptions) =>
    manager.execute(sessionId, body, options);

  const openAiDiscoveryHandler = (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'kitt-reverse-proxy',
      version: '3.0.0',
      model: manager.modelId,
      transport: manager.transport,
      endpoints: {
        openai: {
          chat: '/v1/chat/completions',
          models: '/v1/models',
          responses: '/v1/responses'
        },
        anthropic: {
          messages: '/v1/messages'
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
        health: '/healthz',
        sessions: '/v1/kitt/sessions',
        metrics: '/v1/kitt/metrics'
      },
      capabilities: {
        openai_chat_completions: true,
        openai_responses: true,
        openai_tool_calls: true,
        openai_legacy_functions: true,
        anthropic_messages: true,
        anthropic_tool_use: true,
        ollama_chat: true,
        ollama_tool_calls: true,
        streaming: true,
        structured_output: 'best_effort',
        structured_output_retry: true,
        tool_enforcement: config.toolEnforcement ?? 'explore-first',
        kitt_agent_cli: {
          protocol: 'openai-chat-completions',
          native_tool_roundtrip: true,
          session_header: 'X-Kitt-Session-Id',
          request_id_header: 'X-Kitt-Request-Id',
          parallel_tool_calls_recommended: false
        }
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
        model: manager.modelId,
        transport: manager.transport
      });
      return;
    }
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.send('Ollama is running');
  });

  app.get('/v1', openAiDiscoveryHandler);

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', transport: manager.transport, model: manager.modelId, queueDepth: manager.queueDepth() });
  });

  app.get('/v1/models', (_req: Request, res: Response) => {
    const defaultModels = [
      {
        id: manager.modelId,
        object: 'model',
        created: 1700000000,
        owned_by: 'kitt-reverse-proxy',
        permission: [],
        root: manager.modelId,
        parent: null,
        capabilities: {
          completion: true,
          chat_completion: true,
          tools: true,
          tool_calls: true
        },
        context_window: 128000,
        max_output_tokens: 16384
      }
    ];
    res.json({ object: 'list', data: defaultModels });
  });

  app.get('/v1/models/:model', (req: Request, res: Response) => {
    const requested = req.params.model;
    if (requested !== manager.modelId) {
      sendOpenAiError(res, 404, `Modelo não encontrado: ${requested}`, 'model_not_found');
      return;
    }
    res.json({
      id: requested,
      object: 'model',
      created: 1700000000,
      owned_by: 'kitt-reverse-proxy',
      permission: [],
      root: requested,
      parent: null,
      capabilities: {
        completion: true,
        chat_completion: true,
        tools: true,
        tool_calls: true
      },
      context_window: 128000,
      max_output_tokens: 16384
    });
  });

  app.get(['/v1/capabilities', '/v1/kitt/capabilities'], (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      transport: manager.transport,
      model: manager.modelId,
      structured_output: 'best_effort',
      structured_output_retry: true,
      tool_enforcement: config.toolEnforcement ?? 'explore-first',
      kitt_agent_cli: {
        protocol: 'openai-chat-completions',
        native_tool_roundtrip: true,
        session_header: 'X-Kitt-Session-Id',
        request_id_header: 'X-Kitt-Request-Id',
        parallel_tool_calls_recommended: false
      },
      image_input: {
        chatgpt: true,
        claude: true,
        gemini: true,
        kimi: false,
        deepseek: false
      },
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
          structured_outputs: true
        },
        anthropic: {
          messages: true,
          streaming: true,
          tools: true,
          tool_result: true
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
        conversation_scope: 'multi_session_ui'
      }
    });
  });

  app.get('/v1/kitt/sessions', (_req: Request, res: Response) => {
    res.json({ sessions: manager.list() });
  });

  app.delete('/v1/kitt/sessions/:id', async (req: Request, res: Response) => {
    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      if (!id || id === 'default') {
        sendOpenAiError(res, 400, 'Não é permitido deletar a sessão default.', 'invalid_session_id');
        return;
      }
      const deleted = await manager.delete(id);
      if (!deleted) {
        sendOpenAiError(res, 404, `Sessão não encontrada: ${id}`, 'session_not_found');
        return;
      }
      res.json({ status: 'ok', id });
    } catch (error) {
      logger.warn(`delete session: ${error instanceof Error ? error.message : String(error)}`);
      sendOpenAiError(res, statusForError(error), error instanceof Error ? error.message : 'Erro ao encerrar sessão.', codeForError(error));
    }
  });

  app.get('/v1/kitt/metrics', (req: Request, res: Response) => {
    const accept = req.headers.accept || '';
    if (accept.includes('text/plain; version=0.0.4')) {
      res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send(telemetry.prometheus());
      return;
    }
    res.json(telemetry.snapshot());
  });

  app.get('/api/tags', (_req: Request, res: Response) => {
    res.json(ollamaTagsResponse(manager.modelId));
  });

  app.post('/api/show', (req: Request, res: Response) => {
    const model = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : manager.modelId;
    res.json(ollamaShowResponse(model));
  });

  app.get('/api/version', (_req: Request, res: Response) => {
    res.json({ version: '0.5.1' });
  });

  app.get('/api/ps', (_req: Request, res: Response) => {
    res.json(ollamaTagsResponse(manager.modelId));
  });

  app.get('/v1/kitt/status', (_req: Request, res: Response) => {
    res.json({
      model: manager.modelId,
      transport: manager.transport,
      sessions: manager.list().length,
      queueDepth: manager.queueDepth()
    });
  });

  app.post('/v1/kitt/reset', async (req: Request, res: Response) => {
    try {
      const sessionId = req.get('x-kitt-session-id');
      await manager.reset(sessionId);
      res.json({ status: 'ok' });
    } catch (error) {
      logger.warn(`reset: ${error instanceof Error ? error.message : String(error)}`);
      sendOpenAiError(res, statusForError(error), error instanceof Error ? error.message : 'Erro ao resetar conversa.', codeForError(error));
    }
  });

  app.post('/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      const sessionId = req.get('x-kitt-session-id');
      const body = validateChatBody(req.body);
      const bufferTools = requestMayReturnToolCalls(body) || Boolean(body.response_format);
      if (body.stream === true) {
        const model = typeof body.model === 'string' && body.model.trim() ? body.model : manager.modelId;
        const writer = new ChatStreamWriter(res, model);
        const result = await execute(
          sessionId,
          body,
          bufferTools ? undefined : { onDelta: (delta) => writer.delta(delta) }
        );
        if (result.metadata?.structured_output === 'failed') {
          res.setHeader('X-Kitt-Structured-Output', 'failed');
        }
        const completion = adaptCompletionForLegacyFunctions(result.completion, body);
        writer.finish(completion, bufferTools ? [] : result.deltas);
      } else {
        const result = await execute(sessionId, body);
        if (result.metadata?.structured_output === 'failed') {
          res.setHeader('X-Kitt-Structured-Output', 'failed');
        }
        res.json(adaptCompletionForLegacyFunctions(result.completion, body));
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
      const sessionId = req.get('x-kitt-session-id');
      const body = validateOllamaChatBody(req.body);
      const model = typeof body.model === 'string' && body.model.trim() ? body.model : manager.modelId;
      if (body.stream === true || body.stream === undefined) {
        const writer = new OllamaChatStreamWriter(res, model);
        const bufferTools = requestMayReturnToolCalls(body) || Boolean(body.format);
        const result = await execute(
          sessionId,
          body,
          bufferTools ? undefined : { onDelta: (delta) => writer.delta(delta) }
        );
        if (result.metadata?.structured_output === 'failed') {
          res.setHeader('X-Kitt-Structured-Output', 'failed');
        }
        writer.finish(result.completion);
      } else {
        const result = await execute(sessionId, body);
        if (result.metadata?.structured_output === 'failed') {
          res.setHeader('X-Kitt-Structured-Output', 'failed');
        }
        res.json(completionToOllamaChat(result.completion, model));
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
      const sessionId = req.get('x-kitt-session-id');
      const chatBody = ollamaGenerateBodyToChat(req.body);
      const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model : manager.modelId;
      if (req.body?.stream === true || req.body?.stream === undefined) {
        const writer = new OllamaGenerateStreamWriter(res, model);
        const result = await execute(sessionId, chatBody, { onDelta: (delta) => writer.delta(delta) });
        if (result.metadata?.structured_output === 'failed') {
          res.setHeader('X-Kitt-Structured-Output', 'failed');
        }
        writer.finish();
      } else {
        const result = await execute(sessionId, chatBody);
        if (result.metadata?.structured_output === 'failed') {
          res.setHeader('X-Kitt-Structured-Output', 'failed');
        }
        res.json(completionToOllamaGenerate(result.completion, model));
      }
    } catch (error) {
      const status = isInvalidRequest(error, 'chat') ? 400 : statusForError(error);
      logger.warn(`api/generate: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendOpenAiError(res, status, error instanceof Error ? error.message : 'Erro interno.', codeForError(error));
      else res.end();
    }
  });

  app.post('/v1/messages', async (req: Request, res: Response) => {
    try {
      const sessionId = req.get('x-kitt-session-id');
      const body = anthropicBodyToChat(req.body);
      const bufferTools = requestMayReturnToolCalls(body);
      const requestedModel = typeof req.body?.model === 'string' && req.body.model.trim()
        ? req.body.model.trim()
        : manager.modelId;
      if (req.body?.stream === true) {
        const writer = new AnthropicStreamWriter(res, requestedModel);
        const result = await execute(
          sessionId,
          body,
          bufferTools ? undefined : { onDelta: (delta) => writer.delta(delta) }
        );
        if (result.metadata?.structured_output === 'failed') {
          res.setHeader('X-Kitt-Structured-Output', 'failed');
        }
        writer.finish(result.completion, bufferTools ? [] : result.deltas);
      } else {
        const result = await execute(sessionId, body);
        if (result.metadata?.structured_output === 'failed') {
          res.setHeader('X-Kitt-Structured-Output', 'failed');
        }
        res.json(completionToAnthropic(result.completion));
      }
    } catch (error) {
      const status = isInvalidRequest(error, 'responses') ? 400 : statusForError(error);
      const code = codeForError(error);
      logger.warn(`anthropic/messages: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        sendAnthropicError(
          res,
          status,
          error instanceof Error ? error.message : 'Erro interno.',
          code === 'session_limit_exceeded' ? 'session_limit_exceeded' : (status === 400 ? 'invalid_request_error' : 'api_error')
        );
      } else {
        res.end();
      }
    }
  });

  app.post('/v1/responses', async (req: Request, res: Response) => {
    try {
      const sessionId = req.get('x-kitt-session-id');
      const body = responsesBodyToChat(req.body);
      const bufferTools = requestMayReturnToolCalls(body) || Boolean(body.response_format);
      if (req.body?.stream === true) {
        const model = typeof body.model === 'string' && body.model.trim() ? body.model : manager.modelId;
        const writer = new ResponsesStreamWriter(res, model);
        const result = await execute(
          sessionId,
          body,
          bufferTools ? undefined : { onDelta: (delta) => writer.delta(delta) }
        );
        if (result.metadata?.structured_output === 'failed') {
          res.setHeader('X-Kitt-Structured-Output', 'failed');
        }
        writer.finish(result.completion, bufferTools ? [] : result.deltas);
      } else {
        const result = await execute(sessionId, body);
        if (result.metadata?.structured_output === 'failed') {
          res.setHeader('X-Kitt-Structured-Output', 'failed');
        }
        res.json(completionToResponses(result.completion));
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
