import { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../types.js';
import type { SessionManager } from '../runtime/session-manager.js';
import { modelRecord, runtimeCapabilities, serviceVersion } from './capabilities.js';
import { sendOpenAiError } from './openai.js';
import { sendProxyError } from './http-errors.js';
import { telemetry } from '../util/telemetry.js';
import { withRequestLifecycle } from './request-lifecycle.js';
import { logger } from '../logger.js';

export function createManagementRouter(manager: SessionManager, config: AppConfig): Router {
  const router = Router();

  router.get('/', (req, res) => {
    if (req.headers.accept?.includes('application/json')) {
      res.json({ status: 'ok', service: 'kitt-reverse-proxy', version: serviceVersion() });
      return;
    }
    res.type('text/plain').send('KITT reverse proxy is running');
  });

  router.get('/v1', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'kitt-reverse-proxy',
      version: serviceVersion(),
      provider: manager.providerId,
      model: manager.modelId,
      transport: manager.transport,
      endpoints: {
        openai: { chat: '/v1/chat/completions', models: '/v1/models', responses: '/v1/responses' },
        anthropic: { messages: '/v1/messages' },
        ollama: { chat: '/api/chat', generate: '/api/generate', tags: '/api/tags', version: '/api/version', show: '/api/show' },
        status: '/v1/kitt/status',
        capabilities: '/v1/capabilities',
        health: '/healthz',
        readiness: '/readyz',
        sessions: '/v1/kitt/sessions',
        metrics: '/v1/kitt/metrics'
      },
      capabilities: runtimeCapabilities(manager, config)
    });
  });

  router.get('/readyz', (_req, res) => {
    const capacity = manager.capacity();
    if (capacity.shutting_down) {
      res.status(503).json({ status: 'not_ready' });
      return;
    }
    res.json({
      status: 'ready',
      provider: manager.providerId,
      transport: manager.transport,
      model: manager.modelId,
      queue_depth: manager.queueDepth(),
      sessions: capacity.active
    });
  });

  router.get('/v1/models', (_req, res) => {
    res.json({ object: 'list', data: [modelRecord(manager)] });
  });

  router.get('/v1/models/:model', (req, res) => {
    const requested = Array.isArray(req.params.model) ? req.params.model[0] : req.params.model;
    if (requested !== manager.modelId) {
      sendOpenAiError(res, 404, `Modelo não encontrado: ${requested}`, 'model_not_found');
      return;
    }
    res.json(modelRecord(manager));
  });

  router.get(['/v1/capabilities', '/v1/kitt/capabilities'], (_req, res) => {
    res.json(runtimeCapabilities(manager, config));
  });

  router.get('/v1/kitt/sessions', (_req, res) => {
    res.json({ sessions: manager.list(), capacity: manager.capacity() });
  });

  router.delete('/v1/kitt/sessions/:id', async (req: Request, res: Response) => {
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
      res.json({ status: 'ok', id, capacity: manager.capacity() });
    } catch (error) {
      logger.event('warn', 'session.delete.error', { error });
      sendProxyError(res, error);
    }
  });

  router.post('/v1/kitt/reset', async (req: Request, res: Response) => {
    try {
      await withRequestLifecycle(req, res, async (signal) => {
        await manager.reset(req.get('x-kitt-session-id'), signal);
        res.json({ status: 'ok' });
      });
    } catch (error) {
      logger.event('warn', 'session.reset.error', { error });
      sendProxyError(res, error);
    }
  });

  router.get('/v1/kitt/metrics', (req, res) => {
    const accept = req.headers.accept || '';
    if (accept.includes('text/plain; version=0.0.4')) {
      res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      res.send(telemetry.prometheus());
      return;
    }
    res.json(telemetry.snapshot());
  });

  router.get('/v1/kitt/status', (_req, res) => {
    res.json({
      model: manager.modelId,
      provider: manager.providerId,
      transport: manager.transport,
      sessions: manager.list().length,
      session_capacity: manager.capacity(),
      queue_depth: manager.queueDepth()
    });
  });

  return router;
}
