import { Router, type Request, type Response } from 'express';
import { logger } from '../logger.js';
import { adaptCompletionForLegacyFunctions, requestMayReturnToolCalls } from '../mapping/tool-calling.js';
import { parseReasoningEffortHeader } from '../runtime/reasoning.js';
import type { SessionManager } from '../runtime/session-manager.js';
import type { ChatExecutionOptions } from '../types.js';
import {
  ChatStreamWriter,
  completionToResponses,
  ResponsesStreamWriter,
  responsesBodyToChat
} from './openai.js';
import { sendProxyError } from './http-errors.js';
import { withRequestLifecycle } from './request-lifecycle.js';
import { validateOpenAiChatRequest, validateResponsesRequest } from './request-validation.js';

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
        const body = validateOpenAiChatRequest(req.body);
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
        const body = responsesBodyToChat(source);
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
