#!/usr/bin/env node
import { cliLaunchPresets, parseCliArgs, printHelp } from './config.js';
import { captureChatExchange } from './discovery/capture.js';
import { logger, safeUrlForLog, sanitizeLogMessage } from './logger.js';
import { createAdapter } from './mapping/factory.js';
import { detectProvider, resolveTransport } from './providers/catalog.js';
import { startProxyServer } from './proxy/server.js';
import { openBrowserSession, navigateSession } from './runtime/browser-session.js';
import { NetworkChatExecutor } from './runtime/network-executor.js';
import { UiChatExecutor } from './runtime/ui-executor.js';
import type { ChatExecutor, LiveBrowserSession } from './types.js';

async function createRuntime(config: Exclude<ReturnType<typeof parseCliArgs>, { help: true }>): Promise<{
  executor: ChatExecutor;
  session: LiveBrowserSession;
}> {
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
      return { executor, session };
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
    return { executor: new NetworkChatExecutor(capture, session, adapter, profile, source, config), session };
  } catch (error) {
    await session.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const isGatewayCommand = rawArgs[0] === 'gateway' || process.argv[1]?.endsWith('kitt-agent-gateway') || process.argv[1]?.endsWith('agent-gateway');
  if (isGatewayCommand) {
    const { runGatewayCli } = await import('./gateway/agent-gateway.js');
    const gatewayArgs = rawArgs[0] === 'gateway' ? rawArgs.slice(1) : rawArgs;
    const code = await runGatewayCli(gatewayArgs);
    process.exit(Number.isInteger(code) ? code : 0);
  }

  if (rawArgs[0] === 'presets') {
    console.log('\nPresets disponíveis:\n');
    for (const preset of cliLaunchPresets()) {
      console.log(`  ${preset.id.padEnd(10)} ${preset.targetUrl}`);
      console.log(`             perfil: ${preset.userDataDir}`);
      console.log(`             API model: ${preset.apiModel}`);
    }
    console.log('\nEx.: kitt-reverse-proxy start chatgpt\n');
    return;
  }

  const parentStdinLifecycle = rawArgs.includes('--parent-stdin-lifecycle');
  const args = rawArgs.filter((arg) => arg !== '--parent-stdin-lifecycle');
  const parsed = parseCliArgs(args);
  if ('help' in parsed) { printHelp(); return; }
  const config = parsed;

  let parentClosed = false;
  let shutdownHandler: ((signal: string) => Promise<void>) | null = null;
  if (parentStdinLifecycle) {
    process.stdin.resume();
    process.stdin.once('end', () => {
      parentClosed = true;
      if (shutdownHandler) void shutdownHandler('PARENT_STDIN_EOF');
    });
  }

  const { executor, session } = await createRuntime(config);

  try {
    logger.step(3, 3, 'Iniciando API OpenAI-compatible...');
    const server = await startProxyServer({ executor, config });
    logger.success(`Proxy iniciado em http://${config.host}:${config.port}`);
    logger.info('Endpoints: POST /v1/chat/completions, POST /v1/responses, GET /v1/models, GET /healthz');
    logger.info('Extensões: GET /v1/kitt/status, POST /v1/kitt/reset');
    logger.info('A sessão do Chromium permanecerá ativa enquanto o proxy estiver rodando.');

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`${signal} recebido. Encerrando servidor e sessão browser...`);
      let forced = false;
      const forceTimer = setTimeout(() => {
        forced = true;
        server.closeAllConnections?.();
      }, 5_000);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clearTimeout(forceTimer);
      if (forced) logger.warn('Conexões HTTP remanescentes foram encerradas durante shutdown.');
      await session.close();
    };
    shutdownHandler = shutdown;
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    if (parentClosed) await shutdown('PARENT_STDIN_EOF');
  } catch (error) {
    await session.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  if (process.env.DEBUG === '1' && error instanceof Error && error.stack) console.error(sanitizeLogMessage(error.stack));
  process.exitCode = 1;
});
