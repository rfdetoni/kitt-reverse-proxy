#!/usr/bin/env node
import { parseCliArgs, printHelp } from './config.js';
import { captureChatExchange } from './discovery/capture.js';
import { logger } from './logger.js';
import { createAdapter } from './mapping/factory.js';
import { startProxyServer } from './proxy/server.js';

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if ('help' in parsed) { printHelp(); return; }
  const config = parsed;

  logger.step(1, 3, 'Descobrindo endpoint e sessão do chat...');
  const { capture, session } = await captureChatExchange(config);
  logger.success(`Endpoint encontrado: ${capture.endpointUrl} (score ${capture.score})`);

  try {
    logger.step(2, 3, config.profilePath ? 'Validando profile declarativo...' : 'Aprendendo mapping declarativo...');
    const { adapter, profile, source } = await createAdapter(capture, config);
    logger.success(`Mapping pronto: ${source}. Código gerado por LLM: nenhum.`);

    logger.step(3, 3, 'Iniciando API OpenAI-compatible...');
    const server = await startProxyServer({ capture, session, adapter, profile, profileSource: source, config });
    logger.success(`Proxy iniciado em http://${config.host}:${config.port}`);
    logger.info('Endpoints: POST /v1/chat/completions, POST /v1/responses, GET /v1/models, GET /healthz');
    logger.info('A sessão do Chromium permanecerá ativa enquanto o proxy estiver rodando.');

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`${signal} recebido. Encerrando servidor e sessão browser...`);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await session.close();
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  } catch (error) {
    await session.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  if (process.env.DEBUG === '1' && error instanceof Error && error.stack) console.error(error.stack);
  process.exitCode = 1;
});
