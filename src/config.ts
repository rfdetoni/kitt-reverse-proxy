import type { AppConfig } from './types.js';

const DEFAULTS = Object.freeze({
  model: process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate',
  host: process.env.PROXY_HOST || '127.0.0.1',
  port: Number(process.env.PROXY_PORT || 3000),
  captureTimeoutMs: Number(process.env.CAPTURE_TIMEOUT_MS || 120_000),
  settleAfterCandidateMs: Number(process.env.CAPTURE_SETTLE_MS || 1_500),
  responseSampleTimeoutMs: Number(process.env.RESPONSE_SAMPLE_TIMEOUT_MS || 8_000),
  ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || 60_000),
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 120_000),
  maxQueue: Number(process.env.PROXY_MAX_QUEUE || 64),
  minIntervalMs: Number(process.env.PROXY_MIN_INTERVAL_MS || 0),
  apiKey: process.env.PROXY_API_KEY || undefined
});

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Valor ausente para ${flag}.`);
  }
  return value;
}

function positiveInteger(value: string, flag: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${flag} deve ser um inteiro ${allowZero ? 'não negativo' : 'positivo'}.`);
  }
  return parsed;
}

function validateHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} inválida: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} deve usar http:// ou https://.`);
  }
  return url.toString();
}

function isLoopback(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase());
}

export function parseCliArgs(args: string[]): AppConfig | { help: true } {
  if (args.includes('--help') || args.includes('-h')) return { help: true };

  let targetUrl: string | undefined;
  const config: AppConfig = {
    targetUrl: '',
    model: DEFAULTS.model,
    ollamaUrl: DEFAULTS.ollamaUrl,
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    captureTimeoutMs: DEFAULTS.captureTimeoutMs,
    settleAfterCandidateMs: DEFAULTS.settleAfterCandidateMs,
    responseSampleTimeoutMs: DEFAULTS.responseSampleTimeoutMs,
    ollamaTimeoutMs: DEFAULTS.ollamaTimeoutMs,
    upstreamTimeoutMs: DEFAULTS.upstreamTimeoutMs,
    headed: true,
    cors: true,
    maxQueue: DEFAULTS.maxQueue,
    minIntervalMs: DEFAULTS.minIntervalMs,
    allowedEndpointHosts: [],
    ...(DEFAULTS.apiKey ? { apiKey: DEFAULTS.apiKey } : {})
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('-') && !targetUrl) {
      targetUrl = arg;
      continue;
    }
    switch (arg) {
      case '--model': config.model = readValue(args, index, arg); index += 1; break;
      case '--ollama-url': config.ollamaUrl = readValue(args, index, arg); index += 1; break;
      case '--host': config.host = readValue(args, index, arg); index += 1; break;
      case '--port': config.port = positiveInteger(readValue(args, index, arg), arg); index += 1; break;
      case '--capture-timeout': config.captureTimeoutMs = positiveInteger(readValue(args, index, arg), arg) * 1000; index += 1; break;
      case '--upstream-timeout': config.upstreamTimeoutMs = positiveInteger(readValue(args, index, arg), arg) * 1000; index += 1; break;
      case '--min-interval-ms': config.minIntervalMs = positiveInteger(readValue(args, index, arg), arg, true); index += 1; break;
      case '--max-queue': config.maxQueue = positiveInteger(readValue(args, index, arg), arg); index += 1; break;
      case '--profile': config.profilePath = readValue(args, index, arg); index += 1; break;
      case '--save-profile': config.saveProfilePath = readValue(args, index, arg); index += 1; break;
      case '--api-key': config.apiKey = readValue(args, index, arg); index += 1; break;
      case '--allow-endpoint-host': config.allowedEndpointHosts.push(readValue(args, index, arg).toLowerCase()); index += 1; break;
      case '--headless': config.headed = false; break;
      case '--headed': config.headed = true; break;
      case '--no-cors': config.cors = false; break;
      default: throw new Error(`Argumento desconhecido: ${arg}`);
    }
  }

  if (!targetUrl) throw new Error('Informe a URL do chat. Ex.: adaptive-chat-proxy https://exemplo.com/chat');
  config.targetUrl = validateHttpUrl(targetUrl, 'URL alvo');
  config.ollamaUrl = validateHttpUrl(config.ollamaUrl, 'URL do Ollama');
  if (config.port > 65_535) throw new Error('--port deve estar entre 1 e 65535.');
  if (!isLoopback(config.host) && !config.apiKey) {
    throw new Error('Bind não local exige --api-key ou PROXY_API_KEY.');
  }
  return Object.freeze(config);
}

export function printHelp(): void {
  console.log(`\nAdaptive OpenAI Web Proxy v2\n\nUso:\n  adaptive-chat-proxy <URL-do-chat> [opções]\n\nFluxo:\n  1. Abre o chat no Chromium.\n  2. Envie UMA mensagem manualmente para ensinar o endpoint.\n  3. O proxy aprende um mapping declarativo e mantém a sessão do browser viva.\n\nOpções:\n  --model <nome>              Modelo Ollama (default: ${DEFAULTS.model})\n  --ollama-url <url>          Endpoint /api/generate do Ollama\n  --host <host>               Bind (default: ${DEFAULTS.host})\n  --port <porta>              Porta local (default: ${DEFAULTS.port})\n  --capture-timeout <seg>     Tempo para interação/captura (default: ${DEFAULTS.captureTimeoutMs / 1000})\n  --upstream-timeout <seg>    Timeout por chamada upstream (default: ${DEFAULTS.upstreamTimeoutMs / 1000})\n  --profile <arquivo>         Reusa profile declarativo existente\n  --save-profile <arquivo>    Salva o profile aprendido (sem cookies/headers)\n  --api-key <chave>           Protege o proxy; obrigatório fora de loopback\n  --allow-endpoint-host <h>   Autoriza explicitamente host externo do endpoint (repetível)\n  --min-interval-ms <ms>      Intervalo mínimo entre chamadas upstream\n  --max-queue <n>             Limite da fila serializada (default: ${DEFAULTS.maxQueue})\n  --headless                  Chromium invisível; útil apenas quando não há interação manual\n  --headed                    Chromium visível (default)\n  --no-cors                   Desabilita CORS\n  -h, --help                  Ajuda\n`);
}
