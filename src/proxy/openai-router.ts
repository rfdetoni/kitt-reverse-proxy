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
  responsesBodyToChat
} from './openai.js';
import { parseRequestBody, sendProxyError } from './http-errors.js';
import { withRequestLifecycle } from './request-lifecycle.js';
import { validateOpenAiChatRequest, validateResponsesRequest } from './request-validation.js';

const AGENT_EXECUTION_CONTEXT = `[KITT AGENT EXECUTION CONTEXT]
You are operating through an external agent environment. When functions are supplied, act as an execution agent rather than a conversational advisor.
Use the supplied functions to inspect, create, edit, run, and validate the work whenever they can perform the user's request.
Do not claim that you cannot create or modify files merely because the upstream model is accessed through a chat UI, and do not delegate executable steps back to the user when an available function can perform them.
Continue function/tool round-trips until the requested task is complete or a concrete tool, permission, or policy error blocks progress.
[END KITT AGENT EXECUTION CONTEXT]`;

function hasCallableTools(body: JsonObject): boolean {
  const tools = Array.isArray(body.tools)
    ? body.tools
    : Array.isArray(body.functions)
      ? body.functions
      : [];
  if (!tools.length) return false;
  return body.tool_choice !== 'none' && body.function_call !== 'none';
}

function messageRole(message: unknown): string | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const role = (message as Record<string, unknown>).role;
  return typeof role === 'string' ? role : undefined;
}

function messageContent(message: unknown): string {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return '';
  const content = (message as Record<string, unknown>).content;
  return typeof content === 'string' ? content : '';
}

export function ensureAgentExecutionContext(body: JsonObject): JsonObject {
  if (!hasCallableTools(body)) return body;
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  if (messages.some((message) => messageContent(message).includes('[KITT AGENT EXECUTION CONTEXT]'))) {
    return body;
  }

  let insertionIndex = 0;
  while (
    insertionIndex < messages.length
    && ['system', 'developer'].includes(messageRole(messages[insertionIndex]) ?? '')
  ) {
    insertionIndex += 1;
  }
  messages.splice(insertionIndex, 0, {
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
          writer.finish(adaptCompletionForLegacyFunctions(result.completion, body), bufferTools ? [] : result.deltas);
          return;
        }

        const result = await manager.execute(sessionId, body, baseOptions);
        markStructuredOutput(res, result.metadata?.structured_output === 'failed');
        res.json(adaptCompletionForLegacyFunctions(result.completion, body));
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
          writer.finish(result.completion, bufferTools ? [] : result.deltas);
          return;
        }

        const result = await manager.execute(sessionId, body, { signal });
        markStructuredOutput(res, result.metadata?.structured_output === 'failed');
        res.json(completionToResponses(result.completion));
      });
    } catch (error) {
      logger.event('warn', 'openai.responses.error', { error });
      sendProxyError(res, error);
    }
  });

  return router;
}
