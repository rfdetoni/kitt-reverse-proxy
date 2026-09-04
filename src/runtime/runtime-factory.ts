import { logger, safeUrlForLog } from '../logger.js';
import { captureChatExchange } from '../discovery/capture.js';
import { createAdapter } from '../mapping/factory.js';
import { detectProvider, resolveTransport, type ProviderPreset } from '../providers/catalog.js';
import { openBrowserSession, navigateSession } from './browser-session.js';
import { NetworkChatExecutor } from './network-executor.js';
import { UiChatExecutor } from './ui-executor.js';
import type { AppConfig, ChatExecutor, LiveBrowserSession } from '../types.js';

export interface RuntimeBundle {
  executor: ChatExecutor;
  session: LiveBrowserSession;
  provider: ProviderPreset;
  transport: 'network' | 'ui';
}

export async function createRuntime(config: AppConfig): Promise<RuntimeBundle> {
  const provider = detectProvider(config.targetUrl, config.provider);
  const transport = resolveTransport(config.transport, provider);
  logger.info(`Provider: ${provider.name}; transporte: ${transport}.`);

  if (transport === 'ui') {
    logger.step(1, 3, 'Abrindo sessão web no Chromium...');
    const session = await openBrowserSession(config);
    try {
      await navigateSession(session, config.targetUrl, config.manualInterventionTimeoutMs)
        .catch((error: unknown) => logger.warn(`Navegação não concluiu normalmente: ${error instanceof Error ? error.message : String(error)}`));
      logger.step(2, 3, 'Validando campo de chat e sessão...');
      const executor = new UiChatExecutor(session, provider, config);
      await executor.initialize();
      logger.success(`UI de ${provider.name} pronta. Nenhum endpoint privado foi fixado/reproduzido.`);
      return { executor, session, provider, transport };
    } catch (error) {
      await session.close();
      throw error;
    }
  }

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
      transport
    };
  } catch (error) {
    await session.close();
    throw error;
  }
}
