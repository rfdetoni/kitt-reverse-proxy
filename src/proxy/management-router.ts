import { Router, type Request, type Response } from 'express';
import type { AppConfig, JsonObject } from '../types.js';
import type { SessionManager } from '../runtime/session-manager.js';
import { PROVIDERS, providerById } from '../providers/catalog.js';
import { modelRecord, providerRecord, runtimeCapabilities, serviceVersion } from './capabilities.js';
import { sendOpenAiError } from './openai.js';
import { sendProxyError } from './http-errors.js';
import { telemetry } from '../util/telemetry.js';
import { withRequestLifecycle } from './request-lifecycle.js';
import { logger } from '../logger.js';
import { InvalidRequestError } from '../core/errors.js';
import { normalizeBrowserOriginScope } from '../runtime/browser-automation.js';

const BROWSER_ORIGIN_SCOPE_HEADER = 'X-Kitt-Browser-Origin-Scope';
const MAX_BROWSER_SCOPE_HEADER_CHARS = 4096;

function browserOriginScope(req: Request): string[] {
  const encoded = req.get(BROWSER_ORIGIN_SCOPE_HEADER);
  if (!encoded) return ['loopback'];
  if (encoded.length > MAX_BROWSER_SCOPE_HEADER_CHARS) {
    throw new InvalidRequestError('Browser origin scope header is too large.');
  }
  let decoded: unknown;
  try {
    const raw = Buffer.from(encoded, 'base64url').toString('utf8');
    decoded = JSON.parse(raw);
  } catch {
    throw new InvalidRequestError('Browser origin scope header is invalid.');
  }
  return normalizeBrowserOriginScope(decoded);
}

function resilience(manager: SessionManager): JsonObject | undefined {
  const value = manager.describe().resilience;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

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
        openai: {
          chat: '/v1/chat/completions',
          models: '/v1/models',
          responses: '/v1/responses',
          embeddings: '/v1/embeddings (unsupported: 501)'
        },
        anthropic: { messages: '/v1/messages' },
        ollama: { chat: '/api/chat', generate: '/api/generate', tags: '/api/tags', version: '/api/version', show: '/api/show' },
        providers: '/v1/providers',
        status: '/v1/kitt/status',
        capabilities: '/v1/capabilities',
        health: '/healthz',
        readiness: '/readyz',
        session: '/v1/kitt/session',
        sessions: '/v1/kitt/sessions',
        browser: '/v1/kitt/browser/:action',
        metrics: '/v1/kitt/metrics'
      },
      capabilities: runtimeCapabilities(manager, config)
    });
  });

  router.get('/readyz', (_req, res) => {
    const capacity = manager.capacity();
    if (capacity.shutting_down) {
      res.status(503).json({ status: 'not_ready', reason: 'shutting_down' });
      return;
    }
    const health = resilience(manager);
    if (health?.circuit === 'open') {
      res.status(503).json({
        status: 'not_ready',
        reason: 'provider_circuit_open',
        provider: manager.providerId,
        transport: manager.transport,
        retry_after_ms: health.retry_after_ms ?? 0
      });
      return;
    }
    res.json({
      status: 'ready',
      provider: manager.providerId,
      transport: manager.transport,
      model: manager.modelId,
      queue_depth: manager.queueDepth(),
      sessions: capacity.active,
      resilience: health ?? { circuit: 'closed' }
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

  router.get('/v1/providers', (_req, res) => {
    res.json({ object: 'list', data: PROVIDERS.map((provider) => providerRecord(provider, manager)) });
  });

  router.get('/v1/providers/:provider/models', (req, res) => {
    const id = Array.isArray(req.params.provider) ? req.params.provider[0] : req.params.provider;
    const provider = id ? providerById(id) : undefined;
    if (!provider) {
      sendOpenAiError(res, 404, `Provider não encontrado: ${id || ''}`, 'provider_not_found');
      return;
    }
    res.json({
      object: 'list',
      provider: provider.id,
      data: provider.models.map((item) => ({
        id: item.id,
        object: 'model',
        owned_by: `kitt:${provider.id}`,
        aliases: [...item.aliases]
      }))
    });
  });

  router.get('/v1/providers/:provider', (req, res) => {
    const id = Array.isArray(req.params.provider) ? req.params.provider[0] : req.params.provider;
    const provider = id ? providerById(id) : undefined;
    if (!provider) {
      sendOpenAiError(res, 404, `Provider não encontrado: ${id || ''}`, 'provider_not_found');
      return;
    }
    res.json(providerRecord(provider, manager));
  });

  router.get(['/v1/capabilities', '/v1/kitt/capabilities'], (_req, res) => {
    res.json(runtimeCapabilities(manager, config));
  });

  router.get('/v1/kitt/session', (req, res) => {
    try {
      const id = manager.normalizeSessionId(req.get('x-kitt-session-id'));
      const session = manager.list().find((item) => item.id === id);
      if (!session) {
        sendOpenAiError(res, 404, `Sessão não encontrada: ${id}`, 'session_not_found');
        return;
      }
      res.json({
        session,
        provider: manager.providerId,
        transport: manager.transport,
        model: manager.modelId,
        queue_depth: manager.queueDepth(id),
        resilience: resilience(manager) ?? { circuit: 'closed' },
        capacity: manager.capacity()
      });
    } catch (error) {
      sendProxyError(res, error);
    }
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

  router.post('/v1/kitt/browser/:action', async (req: Request, res: Response) => {
    try {
      const action = Array.isArray(req.params.action) ? req.params.action[0] : req.params.action;
      if (!action) throw new InvalidRequestError('Browser action is required.');
      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new InvalidRequestError('Browser request body must be a JSON object.');
      }
      await withRequestLifecycle(req, res, async (signal) => {
        const result = await manager.browserAction(
          req.get('x-kitt-session-id'),
          action,
          body as JsonObject,
          signal,
          browserOriginScope(req)
        );
        res.json(result);
      });
    } catch (error) {
      logger.event('warn', 'browser.action.error', {
        action: req.params.action,
        error
      });
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
      version: serviceVersion(),
      model: manager.modelId,
      provider: manager.providerId,
      transport: manager.transport,
      resilience: resilience(manager) ?? { circuit: 'closed' },
      sessions: manager.list().length,
      session_capacity: manager.capacity(),
      queue_depth: manager.queueDepth()
    });
  });

  return router;
}
