import { logger, safeUrlForLog } from '../logger.js';
import { captureChatExchange } from '../discovery/capture.js';
import { createAdapter } from '../mapping/factory.js';
import { detectProvider, transportCandidates, type ProviderPreset } from '../providers/catalog.js';
import { telemetry } from '../util/telemetry.js';
import { NetworkChatExecutor } from './network-executor.js';
import { createManagedUiRuntime } from './ui-browser-lifecycle.js';
import type { AppConfig, ChatExecutor, LiveBrowserSession } from '../types.js';

export interface RuntimeBundle {
  executor: ChatExecutor;
  session: LiveBrowserSession;
  provider: ProviderPreset;
  transport: 'network' | 'ui';
}

async function createUiRuntime(config: AppConfig, provider: ProviderPreset): Promise<RuntimeBundle> {
  logger.step(1, 3, 'Preparando sessão web no Chromium...');
  logger.step(2, 3, 'Validando autenticação e campo de chat...');
  const managed = await createManagedUiRuntime(config, provider);
  logger.success(`UI de ${provider.name} pronta. Nenhum endpoint privado foi fixado/reproduzido.`);
  return {
    executor: managed.executor,
    session: managed.session,
    provider,
    transport: 'ui'
  };
}

async function createNetworkRuntime(config: AppConfig, provider: ProviderPreset): Promise<RuntimeBundle> {
  logger.step(1, 3, 'Descobrindo endpoint e sessão do chat...');
  const { capture, session } = await captureChatExchange(config, provider.id);
  logger.success(`Endpoint encontrado: ${safeUrlForLog(capture.endpointUrl)} (score ${capture.score}, codec ${capture.requestCodec.kind})`);
  try {
    logger.step(2, 3, config.profilePath ? 'Validando profile declarativo...' : 'Aprendendo mapping declarativo...');
    const { adapter, profile, source } = await createAdapter(capture, config);
    logger.success(`Mapping pronto: ${source}. Código gerado por LLM: nenhum.`);
    return {
      executor: new NetworkChatExecutor(capture, session, adapter, profile, source, config),
      session,
      provider,
      transport: 'network'
    };
  } catch (error) {
    await session.close();
    throw error;
  }
}

export async function createRuntime(config: AppConfig): Promise<RuntimeBundle> {
  const provider = detectProvider(config.targetUrl, config.provider);
  const candidates = transportCandidates(config.transport, provider);
  logger.info(`Provider: ${provider.name}; transporte: ${candidates.join(' -> ')}.`);

  let lastError: unknown;
  for (const transport of candidates) {
    try {
      return transport === 'ui'
        ? await createUiRuntime(config, provider)
        : await createNetworkRuntime(config, provider);
    } catch (error) {
      lastError = error;
      const hasFallback = config.transport === 'auto' && transport === 'network' && candidates.includes('ui');
      if (!hasFallback) throw error;
      telemetry.recordProviderEvent(provider.id, 'network', 'bootstrap_fallback');
      logger.warn(`Transporte network indisponível para ${provider.name}; usando fallback UI seguro.`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Nenhum transporte disponível para o provider.');
}
