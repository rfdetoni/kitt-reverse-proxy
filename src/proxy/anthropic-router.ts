import { Router, type Request, type Response } from 'express';
import { logger } from '../logger.js';
import { requestMayReturnToolCalls } from '../mapping/tool-calling.js';
import type { SessionManager } from '../runtime/session-manager.js';
import {
  AnthropicStreamWriter,
  anthropicBodyToChat,
  completionToAnthropic
} from './anthropic.js';
import { parseRequestBody, sendProxyError } from './http-errors.js';
import { withRequestLifecycle } from './request-lifecycle.js';

export function createAnthropicRouter(manager: SessionManager): Router {
  const router = Router();

  router.post('/v1/messages', async (req: Request, res: Response) => {
    try {
      await withRequestLifecycle(req, res, async (signal) => {
        const sessionId = req.get('x-kitt-session-id');
        const body = parseRequestBody(anthropicBodyToChat, req.body);
        const bufferTools = requestMayReturnToolCalls(body);
        const requestedModel = typeof req.body?.model === 'string' && req.body.model.trim()
          ? req.body.model.trim()
          : manager.modelId;

        if (req.body?.stream === true) {
          const writer = new AnthropicStreamWriter(res, requestedModel);
          const result = await manager.execute(sessionId, body, {
            signal,
            ...(!bufferTools ? { onDelta: (delta) => writer.delta(delta) } : {})
          });
          if (result.metadata?.structured_output === 'failed' && !res.headersSent) {
            res.setHeader('X-Kitt-Structured-Output', 'failed');
          }
          writer.finish(result.completion, bufferTools ? [] : result.deltas);
          return;
        }

        const result = await manager.execute(sessionId, body, { signal });
        if (result.metadata?.structured_output === 'failed') res.setHeader('X-Kitt-Structured-Output', 'failed');
        res.json(completionToAnthropic(result.completion));
      });
    } catch (error) {
      logger.event('warn', 'anthropic.messages.error', { error });
      sendProxyError(res, error, 'anthropic');
    }
  });

  return router;
}
