import { Router, type Request, type Response } from 'express';
import { logger } from '../logger.js';
import { requestMayReturnToolCalls } from '../mapping/tool-calling.js';
import type { SessionManager } from '../runtime/session-manager.js';
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
import { parseRequestBody, sendProxyError } from './http-errors.js';
import { withRequestLifecycle } from './request-lifecycle.js';

export function createOllamaRouter(manager: SessionManager): Router {
  const router = Router();

  router.get('/api/tags', (_req, res) => res.json(ollamaTagsResponse(manager.modelId)));
  router.get('/api/ps', (_req, res) => res.json(ollamaTagsResponse(manager.modelId)));
  router.get('/api/version', (_req, res) => res.json({ version: '0.5.1' }));
  router.post('/api/show', (req, res) => {
    const model = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : manager.modelId;
    res.json(ollamaShowResponse(model));
  });

  router.post('/api/chat', async (req: Request, res: Response) => {
    try {
      await withRequestLifecycle(req, res, async (signal) => {
        const sessionId = req.get('x-kitt-session-id');
        const body = parseRequestBody(validateOllamaChatBody, req.body);
        const model = typeof body.model === 'string' && body.model.trim() ? body.model : manager.modelId;
        const bufferTools = requestMayReturnToolCalls(body) || Boolean(body.format);

        if (body.stream === true || body.stream === undefined) {
          const writer = new OllamaChatStreamWriter(res, model);
          const result = await manager.execute(sessionId, body, {
            signal,
            ...(!bufferTools ? { onDelta: (delta) => writer.delta(delta) } : {})
          });
          if (result.metadata?.structured_output === 'failed' && !res.headersSent) {
            res.setHeader('X-Kitt-Structured-Output', 'failed');
          }
          writer.finish(result.completion);
          return;
        }

        const result = await manager.execute(sessionId, body, { signal });
        if (result.metadata?.structured_output === 'failed') res.setHeader('X-Kitt-Structured-Output', 'failed');
        res.json(completionToOllamaChat(result.completion, model));
      });
    } catch (error) {
      logger.event('warn', 'ollama.chat.error', { error });
      sendProxyError(res, error);
    }
  });

  router.post('/api/generate', async (req: Request, res: Response) => {
    try {
      await withRequestLifecycle(req, res, async (signal) => {
        const sessionId = req.get('x-kitt-session-id');
        const chatBody = parseRequestBody(ollamaGenerateBodyToChat, req.body);
        const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model : manager.modelId;

        if (req.body?.stream === true || req.body?.stream === undefined) {
          const writer = new OllamaGenerateStreamWriter(res, model);
          const result = await manager.execute(sessionId, chatBody, {
            signal,
            onDelta: (delta) => writer.delta(delta)
          });
          if (result.metadata?.structured_output === 'failed' && !res.headersSent) {
            res.setHeader('X-Kitt-Structured-Output', 'failed');
          }
          writer.finish();
          return;
        }

        const result = await manager.execute(sessionId, chatBody, { signal });
        if (result.metadata?.structured_output === 'failed') res.setHeader('X-Kitt-Structured-Output', 'failed');
        res.json(completionToOllamaGenerate(result.completion, model));
      });
    } catch (error) {
      logger.event('warn', 'ollama.generate.error', { error });
      sendProxyError(res, error);
    }
  });

  return router;
}
