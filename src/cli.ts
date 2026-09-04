#!/usr/bin/env node
import { cliLaunchPresets, parseCliArgs, printHelp } from './config.js';
import { configureLogger, logger, sanitizeLogMessage } from './logger.js';
import { startProxyServer } from './proxy/server.js';
import { createRuntime } from './runtime/runtime-factory.js';
import { createIsolatedUiSession } from './runtime/isolated-ui-session.js';
import { SessionManager } from './runtime/session-manager.js';

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === 'mcp') {
    const { runMcpCli } = await import('./mcp/server.js');
    process.exitCode = await runMcpCli(rawArgs.slice(1));
    return;
  }

  if (rawArgs[0] === 'gateway') {
    const { runGatewayCli } = await import('./gateway/agent-gateway.js');
    const gatewayArgs = rawArgs.slice(1);
    const code = await runGatewayCli(gatewayArgs);
    process.exitCode = Number.isInteger(code) ? code : 0;
    return;
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

  configureLogger({ format: config.logFormat });

  let parentClosed = false;
  let shutdownHandler: ((signal: string) => Promise<void>) | null = null;
  if (parentStdinLifecycle) {
    process.stdin.resume();
    process.stdin.once('end', () => {
      parentClosed = true;
      if (shutdownHandler) void shutdownHandler('PARENT_STDIN_EOF');
    });
  }

  const runtime = await createRuntime(config);
  const manager = new SessionManager({
    defaultExecutor: runtime.executor,
    defaultBrowserSession: runtime.session,
    provider: runtime.provider.id,
    config,
    ...(runtime.transport === 'ui'
      ? { factory: async () => createIsolatedUiSession(runtime.session, runtime.provider, config) }
      : {})
  });

  try {
    logger.step(3, 3, 'Iniciando API OpenAI-compatible...');
    const server = await startProxyServer({ manager, config });
    logger.success(`Proxy iniciado em http://${config.host}:${config.port}`);
    logger.info('Endpoints: POST /v1/chat/completions, POST /v1/responses, GET /v1/models, GET /healthz');
    logger.info('Extensões: GET /v1/kitt/status, POST /v1/kitt/reset, GET /v1/kitt/sessions, GET /v1/kitt/metrics');
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
      await manager.close();
      await runtime.session.close();
    };
    shutdownHandler = shutdown;
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    if (parentClosed) await shutdown('PARENT_STDIN_EOF');
  } catch (error) {
    await manager.close();
    await runtime.session.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  if (process.env.DEBUG === '1' && error instanceof Error && error.stack) console.error(sanitizeLogMessage(error.stack));
  process.exitCode = 1;
});
