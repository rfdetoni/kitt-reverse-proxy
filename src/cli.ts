#!/usr/bin/env node
import { cliLaunchPresets, parseCliArgs, printHelp } from './config.js';
import { closeLogger, configureLogger, logger, sanitizeLogMessage } from './logger.js';
import { flushTracing } from './observability/tracing.js';
import { startProxyServer } from './proxy/server.js';
import { createRuntime } from './runtime/runtime-factory.js';
import { createIsolatedUiSession } from './runtime/isolated-ui-session.js';
import { BrowserSessionBroker } from './runtime/browser-broker.js';
import { SessionManager } from './runtime/session-manager.js';
import { notifyIfUpdateAvailable } from './update-check.js';
import { SERVICE_VERSION } from './version.js';
import { runControlPlaneCli } from './control-plane/cli.js';

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function withoutFlagValue(args: readonly string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      index += 1;
      continue;
    }
    const value = args[index];
    if (value !== undefined) result.push(value);
  }
  return result;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const controlPlaneCode = await runControlPlaneCli(rawArgs);
  if (controlPlaneCode !== null) {
    process.exitCode = controlPlaneCode;
    return;
  }

  if (rawArgs[0] === 'browser-host') {
    const { runBrowserHostCli } = await import('./control-plane/browser-host.js');
    process.exitCode = await runBrowserHostCli(rawArgs.slice(1));
    return;
  }

  await notifyIfUpdateAvailable(import.meta.url);
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
  const rawOwnerPid = flagValue(rawArgs, '--owner-pid');
  const ownerPid = rawOwnerPid === undefined ? undefined : Number(rawOwnerPid);
  if (
    ownerPid !== undefined
    && (!Number.isInteger(ownerPid) || ownerPid < 1)
  ) {
    throw new Error('--owner-pid must be a positive integer.');
  }
  const lifecycleArgs = rawArgs.filter((arg) => arg !== '--parent-stdin-lifecycle');
  const args = withoutFlagValue(lifecycleArgs, '--owner-pid');
  const parsed = parseCliArgs(args);
  if ('help' in parsed) { printHelp(); return; }
  const config = parsed;

  configureLogger({ format: config.logFormat, level: config.logLevel ?? 0, content: config.logContent ?? 'metadata', file: config.logFile });
  logger.debug('proxy.config', { config });
  logger.trace('proxy.config.full', { config, argv: args });

  let parentClosed = false;
  let ownerWatch: NodeJS.Timeout | undefined;
  let shutdownHandler: ((signal: string) => Promise<void>) | null = null;
  if (parentStdinLifecycle) {
    process.stdin.resume();
    process.stdin.once('end', () => {
      parentClosed = true;
      if (shutdownHandler) void shutdownHandler('PARENT_STDIN_EOF');
    });
  }

  const runtime = await createRuntime(config);
  const browserBroker = runtime.transport === 'ui'
    ? new BrowserSessionBroker(runtime.session, config)
    : undefined;
  const manager = new SessionManager({
    defaultExecutor: runtime.executor,
    defaultBrowserSession: runtime.session,
    provider: runtime.provider.id,
    config,
    ...(browserBroker
      ? { factory: async () => createIsolatedUiSession(runtime.session, runtime.provider, config, browserBroker) }
      : {})
  });

  try {
    logger.step(3, 3, 'Iniciando API OpenAI-compatible...');
    const server = await startProxyServer({ manager, config });
    logger.success(`KITT Reverse Proxy v${SERVICE_VERSION} iniciado em http://${config.host}:${config.port}`);
    logger.info('Endpoints: POST /v1/chat/completions, POST /v1/responses, GET /v1/models, GET /healthz');
    logger.info('Extensões: GET /v1/kitt/status, POST /v1/kitt/reset, GET /v1/kitt/sessions, GET /v1/kitt/metrics');
    logger.info(
      runtime.session.headed
        ? 'Chromium visível ativo enquanto o transporte UI precisar da página. Não feche essa janela.'
        : 'Chromium headless ativo em segundo plano; nenhuma janela precisa permanecer aberta.'
    );

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (ownerWatch) {
        clearInterval(ownerWatch);
        ownerWatch = undefined;
      }
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
      await flushTracing();
      await closeLogger();
    };
    shutdownHandler = shutdown;
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    if (ownerPid) {
      ownerWatch = setInterval(() => {
        if (!processAlive(ownerPid)) void shutdown('OWNER_EXIT');
      }, 500);
      ownerWatch.unref();
      if (!processAlive(ownerPid)) await shutdown('OWNER_EXIT');
    }
    if (parentClosed) await shutdown('PARENT_STDIN_EOF');
  } catch (error) {
    if (ownerWatch) clearInterval(ownerWatch);
    await manager.close();
    await runtime.session.close();
    await flushTracing();
    await closeLogger();
    throw error;
  }
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  if (process.env.DEBUG === '1' && error instanceof Error && error.stack) console.error(sanitizeLogMessage(error.stack));
  process.exitCode = 1;
});
