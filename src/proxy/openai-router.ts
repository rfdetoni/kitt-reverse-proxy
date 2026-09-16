import { Router, type Request, type Response } from 'express';
import { logger } from '../logger.js';
import { adaptCompletionForLegacyFunctions, requestMayReturnToolCalls } from '../mapping/tool-calling.js';
import { parseReasoningEffortHeader } from '../runtime/reasoning.js';
import type { SessionManager } from '../runtime/session-manager.js';
import type { ChatExecutionOptions, JsonObject } from '../types.js';
import {
  ChatStreamWriter,
  completionToResponses,
  ResponsesStreamWriter,
  responsesBodyToChat,
  sendOpenAiError
} from './openai.js';
import { parseRequestBody, sendProxyError } from './http-errors.js';
import { withRequestLifecycle } from './request-lifecycle.js';
import { validateOpenAiChatRequest, validateResponsesRequest } from './request-validation.js';
import { withEstimatedUsage } from './token-usage.js';

const AGENT_EXECUTION_CONTEXT = `[AGENT EXECUTION CONTEXT]
You are servicing an external API request through a browser-backed transport. When callable functions are supplied, act as an API execution agent rather than as a conversational chat assistant.
The current API request and the functions explicitly declared in it are the authoritative execution environment for this turn.
Treat the chat product's own workspace, projects, canvas, attached repositories, native tools, connectors, hidden website tool calls, and other UI-only capabilities as unavailable to this API request unless they are explicitly exposed as callable functions in the request.
Do not ask the user to upload, open, attach, or connect a repository/workspace when a declared function can inspect or mutate the host workspace.
When an available function can advance an executable request, respond through the external tool-call protocol instead of giving manual steps, producing workspace code only as prose, or claiming the chat UI cannot perform the work.
Use the declared functions to inspect, create, edit, run, and validate the work, and continue external function/tool round-trips until the requested task is complete or a concrete tool, permission, or policy error blocks progress.
Never claim that you cannot create or modify files merely because the upstream model is accessed through a chat UI.
[END AGENT EXECUTION CONTEXT]`;

function hasCallableTools(body: JsonObject): boolean {
  const tools = Array.isArray(body.tools)
    ? body.tools
    : Array.isArray(body.functions)
      ? body.functions
      : [];
  if (!tools.length) return false;
  return body.tool_choice !== 'none' && body.function_call !== 'none';
}

function messageContent(message: unknown): string {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return '';
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : '';
}

export function ensureAgentExecutionContext(body: JsonObject): JsonObject {
  if (!hasCallableTools(body)) return body;
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  if (messages.some((message) => messageContent(message).includes('[AGENT EXECUTION CONTEXT]'))) {
    return body;
  }

  messages.unshift({
    role: 'system',
    content: AGENT_EXECUTION_CONTEXT
  });
  return { ...body, messages };
}

function markStructuredOutput(res: Response, failed: boolean): void {
  if (failed && !res.headersSent) res.setHeader('X-Kitt-Structured-Output', 'failed');
}

export function createOpenAiRouter(manager: SessionManager): Router {
  const router = Router();

  router.post('/v1/embeddings', (_req: Request, res: Response) => {
    sendOpenAiError(
      res,
      501,
      'Embeddings não são suportados por transports baseados em chats web.',
      'embeddings_not_supported'
    );
  });

  router.post('/v1/chat/completions', async (req: Request, res: Response) => {
    try {
      await withRequestLifecycle(req, res, async (signal) => {
        const sessionId = req.get('x-kitt-session-id');
        const reasoningEffort = parseReasoningEffortHeader(req.get('x-kitt-reasoning-effort'));
        const body = ensureAgentExecutionContext(validateOpenAiChatRequest(req.body));
        const bufferTools = requestMayReturnToolCalls(body) || Boolean(body.response_format);
        const baseOptions: ChatExecutionOptions = {
          signal,
          ...(reasoningEffort !== undefined ? { reasoningEffort } : {})
        };

        if (body.stream === true) {
          const model = typeof body.model === 'string' && body.model.trim() ? body.model : manager.modelId;
          const writer = new ChatStreamWriter(res, model);
          const result = await manager.execute(sessionId, body, {
            ...baseOptions,
            ...(!bufferTools ? { onDelta: (delta) => writer.delta(delta) } : {})
          });
          markStructuredOutput(res, result.metadata?.structured_output === 'failed');
          const completion = withEstimatedUsage(result.completion, body);
          writer.finish(adaptCompletionForLegacyFunctions(completion, body), bufferTools ? [] : result.deltas);
          return;
        }

        const result = await manager.execute(sessionId, body, baseOptions);
        markStructuredOutput(res, result.metadata?.structured_output === 'failed');
        const completion = withEstimatedUsage(result.completion, body);
        res.json(adaptCompletionForLegacyFunctions(completion, body));
      });
    } catch (error) {
      logger.event('warn', 'openai.chat.error', { error });
      sendProxyError(res, error);
    }
  });

  router.post('/v1/responses', async (req: Request, res: Response) => {
    try {
      await withRequestLifecycle(req, res, async (signal) => {
        const sessionId = req.get('x-kitt-session-id');
        const source = validateResponsesRequest(req.body);
        const body = ensureAgentExecutionContext(parseRequestBody(responsesBodyToChat, source));
        const bufferTools = requestMayReturnToolCalls(body) || Boolean(body.response_format);

        if (source.stream === true) {
          const model = typeof body.model === 'string' && body.model.trim() ? body.model : manager.modelId;
          const writer = new ResponsesStreamWriter(res, model);
          const result = await manager.execute(sessionId, body, {
            signal,
            ...(!bufferTools ? { onDelta: (delta) => writer.delta(delta) } : {})
          });
          markStructuredOutput(res, result.metadata?.structured_output === 'failed');
          const completion = withEstimatedUsage(result.completion, body);
          writer.finish(completion, bufferTools ? [] : result.deltas);
          return;
        }

        const result = await manager.execute(sessionId, body, { signal });
        markStructuredOutput(res, result.metadata?.structured_output === 'failed');
        const completion = withEstimatedUsage(result.completion, body);
        res.json(completionToResponses(completion));
      });
    } catch (error) {
      logger.event('warn', 'openai.responses.error', { error });
      sendProxyError(res, error);
    }
  });

  return router;
}
