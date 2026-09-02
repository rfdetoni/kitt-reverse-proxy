import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROVIDERS, providerIds } from './providers/catalog.js';
import type { AppConfig, ProviderId, TransportMode } from './types.js';
import {
  boolSetting,
  controlCenterSection,
  numberSetting,
  stringListSetting,
  stringSetting
} from './control-center.js';

const CENTER = controlCenterSection('reverse_proxy.runtime');
const secretEnv = stringSetting(CENTER, 'api_key_env');

const DEFAULTS = Object.freeze({
  model: process.env.OLLAMA_MODEL || stringSetting(CENTER, 'model') || '',
  apiModel: process.env.PROXY_MODEL_ID || stringSetting(CENTER, 'api_model') || undefined,
  ollamaUrl: process.env.OLLAMA_URL || stringSetting(CENTER, 'ollama_url') || 'http://127.0.0.1:11434/api/generate',
  host: process.env.PROXY_HOST || stringSetting(CENTER, 'host') || '127.0.0.1',
  port: Number(process.env.PROXY_PORT || numberSetting(CENTER, 'port') || 3000),
  captureTimeoutMs: Number(process.env.CAPTURE_TIMEOUT_MS || numberSetting(CENTER, 'capture_timeout_ms') || 120_000),
  settleAfterCandidateMs: Number(process.env.CAPTURE_SETTLE_MS || numberSetting(CENTER, 'settle_after_candidate_ms') || 1_500),
  responseSampleTimeoutMs: Number(process.env.RESPONSE_SAMPLE_TIMEOUT_MS || numberSetting(CENTER, 'response_sample_timeout_ms') || 8_000),
  ollamaTimeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS || numberSetting(CENTER, 'ollama_timeout_ms') || 60_000),
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || numberSetting(CENTER, 'upstream_timeout_ms') || 120_000),
  uiResponseTimeoutMs: Number(process.env.UI_RESPONSE_TIMEOUT_MS || numberSetting(CENTER, 'ui_response_timeout_ms') || 180_000),
  uiSettleMs: Number(process.env.UI_SETTLE_MS || numberSetting(CENTER, 'ui_settle_ms') || 1_200),
  manualInterventionTimeoutMs: Number(process.env.MANUAL_INTERVENTION_TIMEOUT_MS || numberSetting(CENTER, 'manual_intervention_timeout_ms') || 300_000),
  maxQueue: Number(process.env.PROXY_MAX_QUEUE || numberSetting(CENTER, 'max_queue') || 64),
  minIntervalMs: Number(process.env.PROXY_MIN_INTERVAL_MS || numberSetting(CENTER, 'min_interval_ms') || 0),
  apiKey: process.env.PROXY_API_KEY || (secretEnv ? process.env[secretEnv] : undefined),
  userDataDir: process.env.BROWSER_USER_DATA_DIR || stringSetting(CENTER, 'user_data_dir') || undefined,
  cdpUrl: process.env.CDP_URL || stringSetting(CENTER, 'cdp_url') || undefined,
  followRedirects: process.env.PROXY_FOLLOW_REDIRECTS ? process.env.PROXY_FOLLOW_REDIRECTS === 'true' : (boolSetting(CENTER, 'follow_redirects') ?? false),
  headed: boolSetting(CENTER, 'headed') ?? true,
  provider: (process.env.PROXY_PROVIDER || stringSetting(CENTER, 'provider') || 'auto') as ProviderId,
  transport: (process.env.PROXY_TRANSPORT || stringSetting(CENTER, 'transport') || 'auto') as TransportMode
});

const TRANSPORTS = new Set<TransportMode>(['auto', 'network', 'ui']);
const PROVIDER_IDS = new Set<ProviderId>(['auto', ...providerIds()]);


export interface CliLaunchPreset {
  id: string;
  name: string;
  targetUrl: string;
  apiModel: string;
  userDataDir: string;
}

export function cliLaunchPresets(): CliLaunchPreset[] {
  return PROVIDERS
    .filter((item) => item.id !== 'generic' && item.ui.newChatUrl)
    .map((item) => ({
      id: item.id,
      name: item.name,
      targetUrl: item.ui.newChatUrl!,
      apiModel: item.defaultApiModel,
      userDataDir: join(homedir(), '.kitt-reverse-proxy', item.id)
    }));
}

function cliLaunchPreset(value: string): CliLaunchPreset | undefined {
  const normalized = value.trim().toLowerCase();
  return cliLaunchPresets().find((item) => item.id === normalized);
}


function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Valor ausente para ${flag}.`);
  return value;
}

function integer(value: string | number, label: string, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || (allowZero ? parsed < 0 : parsed <= 0)) {
    throw new Error(`${label} deve ser um inteiro ${allowZero ? 'não negativo' : 'positivo'}.`);
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
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} deve usar http:// ou https://.`);
  if (url.username || url.password) throw new Error(`${label} não pode conter credenciais embutidas.`);
  return url.toString();
}

function isLoopback(host: string): boolean {
  return ['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase());
}

function endpointHost(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\.$/, '');
  if (!normalized || normalized.includes('://') || normalized.includes('/') || normalized.includes('*') || normalized.includes('@') || normalized.includes(':')) {
    throw new Error(`Host inválido para --allow-endpoint-host: ${value}. Informe apenas o hostname.`);
  }
  if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.startsWith('.') || normalized.endsWith('.') || normalized.includes('..')) {
    throw new Error(`Host inválido para --allow-endpoint-host: ${value}.`);
  }
  return normalized;
}

function provider(value: string): ProviderId {
  const normalized = value.toLowerCase() as ProviderId;
  if (!PROVIDER_IDS.has(normalized)) throw new Error(`Provider inválido: ${value}. Use: ${[...PROVIDER_IDS].join(', ')}.`);
  return normalized;
}

function transport(value: string): TransportMode {
  const normalized = value.toLowerCase() as TransportMode;
  if (!TRANSPORTS.has(normalized)) throw new Error(`Transport inválido: ${value}. Use: auto, ui ou network.`);
  return normalized;
}

function validateDefaults(config: AppConfig): void {
  config.port = integer(config.port, 'PROXY_PORT');
  config.captureTimeoutMs = integer(config.captureTimeoutMs, 'CAPTURE_TIMEOUT_MS');
  config.settleAfterCandidateMs = integer(config.settleAfterCandidateMs, 'CAPTURE_SETTLE_MS');
  config.responseSampleTimeoutMs = integer(config.responseSampleTimeoutMs, 'RESPONSE_SAMPLE_TIMEOUT_MS');
  config.ollamaTimeoutMs = integer(config.ollamaTimeoutMs, 'OLLAMA_TIMEOUT_MS');
  config.upstreamTimeoutMs = integer(config.upstreamTimeoutMs, 'UPSTREAM_TIMEOUT_MS');
  config.uiResponseTimeoutMs = integer(config.uiResponseTimeoutMs, 'UI_RESPONSE_TIMEOUT_MS');
  config.uiSettleMs = integer(config.uiSettleMs, 'UI_SETTLE_MS');
  config.manualInterventionTimeoutMs = integer(config.manualInterventionTimeoutMs, 'MANUAL_INTERVENTION_TIMEOUT_MS');
  config.maxQueue = integer(config.maxQueue, 'PROXY_MAX_QUEUE');
  config.minIntervalMs = integer(config.minIntervalMs, 'PROXY_MIN_INTERVAL_MS', true);
  config.provider = provider(config.provider);
  config.transport = transport(config.transport);
}

export function parseCliArgs(args: string[]): AppConfig | { help: true } {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  args = args[0] === 'start' ? args.slice(1) : [...args];

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
    uiResponseTimeoutMs: DEFAULTS.uiResponseTimeoutMs,
    uiSettleMs: DEFAULTS.uiSettleMs,
    manualInterventionTimeoutMs: DEFAULTS.manualInterventionTimeoutMs,
    headed: DEFAULTS.headed,
    cors: boolSetting(CENTER, 'cors') ?? true,
    maxQueue: DEFAULTS.maxQueue,
    minIntervalMs: DEFAULTS.minIntervalMs,
    allowedEndpointHosts: stringListSetting(CENTER, 'allowed_endpoint_hosts') || [],
    followRedirects: DEFAULTS.followRedirects,
    provider: DEFAULTS.provider,
    transport: DEFAULTS.transport,
    ...(DEFAULTS.apiKey ? { apiKey: DEFAULTS.apiKey } : {}),
    ...(DEFAULTS.apiModel ? { apiModel: DEFAULTS.apiModel } : {}),
    ...(DEFAULTS.userDataDir ? { userDataDir: DEFAULTS.userDataDir } : {}),
    ...(DEFAULTS.cdpUrl ? { cdpUrl: DEFAULTS.cdpUrl } : {})
  };

  const preset = args[0] && !args[0].startsWith('-') ? cliLaunchPreset(args[0]) : undefined;
  if (preset) {
    targetUrl = preset.targetUrl;
    config.provider = preset.id as ProviderId;
    config.transport = 'ui';
    config.apiModel ??= preset.apiModel;
    config.userDataDir ??= preset.userDataDir;
    args = args.slice(1);
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('-') && !targetUrl) { targetUrl = arg; continue; }
    switch (arg) {
      case '--model': config.model = readValue(args, index, arg); index += 1; break;
      case '--api-model': config.apiModel = readValue(args, index, arg); index += 1; break;
      case '--ollama-url': config.ollamaUrl = readValue(args, index, arg); index += 1; break;
      case '--host': config.host = readValue(args, index, arg); index += 1; break;
      case '--port': config.port = integer(readValue(args, index, arg), arg); index += 1; break;
      case '--capture-timeout': config.captureTimeoutMs = integer(readValue(args, index, arg), arg) * 1000; index += 1; break;
      case '--upstream-timeout': config.upstreamTimeoutMs = integer(readValue(args, index, arg), arg) * 1000; index += 1; break;
      case '--ui-response-timeout': config.uiResponseTimeoutMs = integer(readValue(args, index, arg), arg) * 1000; index += 1; break;
      case '--ui-settle-ms': config.uiSettleMs = integer(readValue(args, index, arg), arg); index += 1; break;
      case '--manual-intervention-timeout': config.manualInterventionTimeoutMs = integer(readValue(args, index, arg), arg) * 1000; index += 1; break;
      case '--min-interval-ms': config.minIntervalMs = integer(readValue(args, index, arg), arg, true); index += 1; break;
      case '--max-queue': config.maxQueue = integer(readValue(args, index, arg), arg); index += 1; break;
      case '--profile': config.profilePath = readValue(args, index, arg); index += 1; break;
      case '--save-profile': config.saveProfilePath = readValue(args, index, arg); index += 1; break;
      case '--user-data-dir': config.userDataDir = readValue(args, index, arg); index += 1; break;
      case '--cdp-url': config.cdpUrl = readValue(args, index, arg); index += 1; break;
      case '--api-key': config.apiKey = readValue(args, index, arg); index += 1; break;
      case '--provider': config.provider = provider(readValue(args, index, arg)); index += 1; break;
      case '--transport': config.transport = transport(readValue(args, index, arg)); index += 1; break;
      case '--allow-endpoint-host': config.allowedEndpointHosts.push(endpointHost(readValue(args, index, arg))); index += 1; break;
      case '--headless': config.headed = false; break;
      case '--headed': config.headed = true; break;
      case '--no-cors': config.cors = false; break;
      case '--follow-redirects': config.followRedirects = true; break;
      case '--no-redirects': config.followRedirects = false; break;
      case '--stealth':
      case '--captcha-solver':
      case '--bypass':
        throw new Error(`${arg} não é suportado. Desafios de segurança exigem resolução manual no navegador.`);
      default: throw new Error(`Argumento desconhecido: ${arg}`);
    }
  }

  if (!targetUrl) throw new Error('Informe um preset ou URL. Ex.: kitt-reverse-proxy chatgpt | kitt-reverse-proxy https://exemplo.com/chat');
  validateDefaults(config);
  config.targetUrl = validateHttpUrl(targetUrl, 'URL alvo');
  config.ollamaUrl = validateHttpUrl(config.ollamaUrl, 'URL do Ollama');
  if (config.cdpUrl) config.cdpUrl = validateHttpUrl(config.cdpUrl, 'CDP URL');
  if (config.port > 65_535) throw new Error('--port deve estar entre 1 e 65535.');
  if (!isLoopback(config.host) && !config.apiKey) throw new Error('Bind não local exige --api-key ou PROXY_API_KEY.');
  return Object.freeze(config);
}

export function printHelp(): void {
  console.log(`\nkitt-reverse-proxy v3\n\nUso rápido:\n  kitt-reverse-proxy chatgpt\n  kitt-reverse-proxy start claude\n  kitt-reverse-proxy presets\n  kitt-reverse-proxy <URL-do-chat> [opções]\n\nPresets derivados do catálogo canônico:\n  chatgpt | claude | gemini | kimi | deepseek\n  Cada preset usa UI transport e perfil Chromium dedicado quando user_data_dir não estiver configurado.\n\nTransporte automático:\n  ChatGPT / Claude / Gemini / Kimi / DeepSeek -> UI do navegador\n  Outros chats -> descoberta de rede + mapping declarativo\n\nOpções:\n  --provider <id>             auto|generic|chatgpt|claude|gemini|kimi|deepseek\n  --transport <modo>          auto|ui|network\n  --api-model <id>            ID exposto em /v1/models\n  --model <nome>              Modelo Ollama opcional para aprender mappings de rede\n  --ollama-url <url>          Endpoint /api/generate do Ollama\n  --user-data-dir <dir>       Perfil Chromium persistente para login/sessão\n  --cdp-url <url>             Conecta a navegador já aberto com remote debugging (ex.: http://127.0.0.1:9222)\n  --host <host>               Bind (default: ${DEFAULTS.host})\n  --port <porta>              Porta local (default: ${DEFAULTS.port})\n  --capture-timeout <seg>     Tempo para captura de rede\n  --upstream-timeout <seg>    Timeout por chamada de rede\n  --ui-response-timeout <seg> Timeout de resposta via UI\n  --ui-settle-ms <ms>         Estabilidade necessária para considerar resposta concluída\n  --manual-intervention-timeout <seg> Tempo para login/CAPTCHA manual\n  --profile <arquivo>         Reusa profile declarativo existente\n  --save-profile <arquivo>    Salva profile aprendido, sem cookies/headers\n  --api-key <chave>           Protege o proxy; obrigatório fora de loopback\n  --allow-endpoint-host <h>   Autoriza host externo em transporte network (repetível)\n  --min-interval-ms <ms>      Intervalo mínimo entre chamadas upstream\n  --max-queue <n>             Limite da fila serializada\n  --headless                  Chromium invisível\n  --headed                    Chromium visível (default)\n  --no-cors                   Desabilita CORS\n  --follow-redirects          Permite redirects no transporte network (opt-in)\n  --no-redirects              Bloqueia redirects (default)\n  -h, --help                  Ajuda\n\nSegurança:\n  CAPTCHA, login e desafios anti-bot são detectados e exigem intervenção manual.\n  O projeto não implementa stealth, solver de CAPTCHA ou bypass de controles de acesso.\n`);
}
