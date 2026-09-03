import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';

const DEFAULT_LOCAL_KEY = 'kitt-local';
const MAX_GATEWAY_JSON_BYTES = 1024 * 1024;
export const DEFAULT_GATEWAY_BASE = 'http://127.0.0.1:3000';
export const DEFAULT_OPENAI_MODEL = 'chatgpt-web';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-web';

const DIRECT_PROVIDER_ENV = [
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_HOST',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_URL',
  'OLLAMA_HOST',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEDROCK_BASE_URL',
  'VERTEX_BASE_URL',
];
const SECRET_ENV = new Set([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'PROXY_API_KEY'
]);

export interface GatewayOptions {
  baseUrl?: string | undefined;
  openaiModel?: string | undefined;
  anthropicModel?: string | undefined;
  apiKey?: string | undefined;
  codex?: boolean | undefined;
  claude?: boolean | undefined;
  opencode?: boolean | undefined;
  path?: string | undefined;
  executable?: string | undefined;
  revealSecrets?: boolean | undefined;
}

export function normalizeBaseUrl(value?: string): string {
  const url = new URL(value || DEFAULT_GATEWAY_BASE);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Gateway URL deve usar http/https.');
  if (url.username || url.password) throw new Error('Gateway URL não pode conter credenciais.');
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('KITT-only exige gateway em loopback.');
  }
  if (url.search || url.hash) {
    throw new Error('Gateway URL não pode conter query string ou fragmento.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Gateway URL deve apontar para a raiz do proxy, sem path adicional.');
  }
  return url.toString().replace(/\/$/, '');
}

function openAiBase(base: string): string {
  return `${base}/v1`;
}

function effectiveApiKey(options: GatewayOptions, baseEnv: NodeJS.ProcessEnv): string {
  return options.apiKey || baseEnv.PROXY_API_KEY || DEFAULT_LOCAL_KEY;
}

function cleanEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of DIRECT_PROVIDER_ENV) delete env[key];

  for (const key of Object.keys(env)) {
    if (/^JETBRAINS_AI/i.test(key) || /^JB_AI_/i.test(key)) delete env[key];
  }

  const nodeBinDir = dirname(process.execPath);
  const extraPaths = [
    nodeBinDir,
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.opencode', 'bin'),
  ].filter(Boolean);
  const currentPath = env.PATH || '';
  const pathParts = [...extraPaths, ...(currentPath ? [currentPath] : [])];
  env.PATH = pathParts.join(delimiter);

  return env;
}

export function buildAgentEnvironment(
  agent: string,
  options: GatewayOptions = {},
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const base = normalizeBaseUrl(options.baseUrl || DEFAULT_GATEWAY_BASE);
  const openaiModel = options.openaiModel || DEFAULT_OPENAI_MODEL;
  const anthropicModel = options.anthropicModel || DEFAULT_ANTHROPIC_MODEL;
  const env = cleanEnvironment(baseEnv);
  const apiKey = effectiveApiKey(options, baseEnv);

  env.KITT_ONLY = '1';
  env.KITT_REVERSE_PROXY_URL = base;
  env.KITT_AGENT_GATEWAY = '1';

  if (agent === 'codex') {
    env.OPENAI_API_KEY = apiKey;
    env.OPENAI_BASE_URL = openAiBase(base);
    env.NO_BROWSER = '1';
    env.MODEL_PROVIDER = 'kitt';
    env.DEFAULT_AUTH_REQUEST = JSON.stringify({ method: 'api-key' });
    env.CODEX_CONFIG = JSON.stringify({
      model: openaiModel,
      model_provider: 'kitt',
      model_providers: {
        kitt: {
          name: 'KITT Reverse Proxy',
          base_url: openAiBase(base),
          env_key: 'OPENAI_API_KEY',
          wire_api: 'responses',
          requires_openai_auth: false,
          request_max_retries: 1,
          stream_max_retries: 1,
          stream_idle_timeout_ms: 300000
        }
      }
    });
    return env;
  }

  if (agent === 'claude') {
    env.ANTHROPIC_BASE_URL = base;
    env.ANTHROPIC_API_KEY = apiKey;
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
    env.ANTHROPIC_MODEL = anthropicModel;
    return env;
  }

  if (agent === 'opencode' || agent === 'openai') {
    env.OPENAI_API_KEY = apiKey;
    env.OPENAI_BASE_URL = openAiBase(base);
    env.OPENAI_MODEL = openaiModel;
    return env;
  }

  if (agent === 'ollama') {
    env.OLLAMA_HOST = base;
    env.OLLAMA_MODEL = openaiModel;
    return env;
  }

  throw new Error(`Agente/protocolo não suportado: ${agent}`);
}

export function defaultAgentCommand(agent: string): { command: string; args: string[] } {
  switch (agent) {
    case 'codex':
      return { command: 'codex-acp', args: [] };
    case 'claude':
      return { command: 'claude-agent-acp', args: [] };
    case 'opencode':
      return { command: 'opencode', args: ['acp'] };
    default:
      throw new Error(`Agent desconhecido: ${agent}`);
  }
}

export async function spawnAndWait(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: 'inherit',
      shell: false,
      windowsHide: false,
    });
    const forward = (signal: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal);
    };
    process.once('SIGINT', forward);
    process.once('SIGTERM', forward);
    child.once('error', (error) => {
      process.removeListener('SIGINT', forward);
      process.removeListener('SIGTERM', forward);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', forward);
      process.removeListener('SIGTERM', forward);
      resolvePromise(signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : (code ?? 1));
    });
  });
}

function gatewayArgs(options: { baseUrl: string; openaiModel: string; anthropicModel: string }): string[] {
  return [
    '--base-url', options.baseUrl,
    '--openai-model', options.openaiModel,
    '--anthropic-model', options.anthropicModel,
  ];
}

export function buildJetBrainsEntries(
  executable: string,
  options: GatewayOptions = {}
): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  const baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_GATEWAY_BASE);
  const openaiModel = options.openaiModel || DEFAULT_OPENAI_MODEL;
  const anthropicModel = options.anthropicModel || DEFAULT_ANTHROPIC_MODEL;
  const baseArgs = gatewayArgs({ baseUrl, openaiModel, anthropicModel });
  const nodeBinDir = dirname(process.execPath);
  const pathValue = [nodeBinDir, join(homedir(), '.local', 'bin'), join(homedir(), '.opencode', 'bin'), process.env.PATH || ''].filter(Boolean).join(delimiter);
  const envBlock = {
    KITT_ONLY: '1',
    PATH: pathValue
  };
  const entries: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};

  if (options.codex !== false) {
    entries['KITT · Codex'] = {
      command: executable,
      args: ['agent', 'codex', ...baseArgs],
      env: envBlock
    };
  }
  if (options.claude !== false) {
    entries['KITT · Claude'] = {
      command: executable,
      args: ['agent', 'claude', ...baseArgs],
      env: envBlock
    };
  }
  if (options.opencode) {
    entries['KITT · OpenCode'] = {
      command: executable,
      args: ['agent', 'opencode', ...baseArgs],
      env: envBlock
    };
  }
  return entries;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_GATEWAY_JSON_BYTES) {
      throw new Error(`arquivo excede ${MAX_GATEWAY_JSON_BYTES} bytes`);
    }
    return JSON.parse(text) as T;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return fallback;
    throw new Error(`${path}: JSON inválido: ${error.message}`);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

export async function installJetBrains(options: GatewayOptions = {}): Promise<{ configPath: string; installed: string[] }> {
  const configPath = options.path || join(homedir(), '.jetbrains', 'acp.json');
  const executable = options.executable || 'kitt-agent-gateway';
  const current = await readJson<Record<string, any>>(configPath, { default_mcp_settings: {}, agent_servers: {} });

  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('acp.json precisa ser um objeto.');
  }
  if (!current.agent_servers || typeof current.agent_servers !== 'object' || Array.isArray(current.agent_servers)) {
    current.agent_servers = {};
  }

  const entries = buildJetBrainsEntries(executable, options);
  current.agent_servers = { ...current.agent_servers, ...entries };
  await writeJsonAtomic(configPath, current);
  return { configPath, installed: Object.keys(entries) };
}

export async function uninstallJetBrains(options: GatewayOptions = {}): Promise<{ configPath: string; removed: string[] }> {
  const configPath = options.path || join(homedir(), '.jetbrains', 'acp.json');
  const current = await readJson<Record<string, any>>(configPath, { default_mcp_settings: {}, agent_servers: {} });
  if (!current.agent_servers || typeof current.agent_servers !== 'object') {
    return { configPath, removed: [] };
  }
  const removed: string[] = [];
  for (const name of ['KITT · Codex', 'KITT · Claude', 'KITT · OpenCode']) {
    if (Object.prototype.hasOwnProperty.call(current.agent_servers, name)) {
      delete current.agent_servers[name];
      removed.push(name);
    }
  }
  await writeJsonAtomic(configPath, current);
  return { configPath, removed };
}

async function requestJson(url: string, init: RequestInit = {}): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_GATEWAY_JSON_BYTES) {
      throw new Error(`Resposta do gateway excede ${MAX_GATEWAY_JSON_BYTES} bytes.`);
    }
    const body = raw ? JSON.parse(raw) : {};
    if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyGateway(baseUrl: string = DEFAULT_GATEWAY_BASE): Promise<{
  status: string;
  base_url: string;
  openai: boolean;
  responses: boolean;
  anthropic: boolean;
  tools: boolean;
  models: string[];
}> {
  const base = normalizeBaseUrl(baseUrl);
  const [caps, models] = await Promise.all([
    requestJson(`${base}/v1/capabilities`),
    requestJson(`${base}/v1/models`)
  ]);
  const modelIds = Array.isArray(models.data) ? models.data.map((item: any) => item.id).filter(Boolean) : [];
  return {
    status: 'ok',
    base_url: base,
    openai: Boolean(caps.protocols?.openai?.chat_completions),
    responses: Boolean(caps.protocols?.openai?.responses),
    anthropic: Boolean(caps.protocols?.anthropic?.messages),
    tools: Boolean(caps.protocols?.openai?.tools),
    models: modelIds,
  };
}

export function valueAfter(args: string[], flag: string, fallback?: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Valor ausente para ${flag}`);
  return value;
}

export function has(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function parseGatewayOptions(args: string[]): GatewayOptions {
  return {
    baseUrl: normalizeBaseUrl(valueAfter(args, '--base-url', DEFAULT_GATEWAY_BASE)),
    openaiModel: valueAfter(args, '--openai-model', DEFAULT_OPENAI_MODEL),
    anthropicModel: valueAfter(args, '--anthropic-model', DEFAULT_ANTHROPIC_MODEL),
    apiKey: valueAfter(args, '--api-key', process.env.PROXY_API_KEY || undefined),
    revealSecrets: has(args, '--reveal-secrets')
  };
}

export function redactedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of SECRET_ENV) {
    if (out[key]) out[key] = '<redacted>';
  }
  return out;
}

export function printGatewayHelp(): void {
  console.log(`
kitt-reverse-proxy gateway / kitt-agent-gateway

Uso:
  kitt-reverse-proxy gateway agent codex [opções]
  kitt-reverse-proxy gateway agent claude [opções]
  kitt-reverse-proxy gateway agent opencode [opções]

  kitt-reverse-proxy gateway exec <codex|claude|openai|ollama> [opções] -- <comando> [args...]

  kitt-reverse-proxy gateway jetbrains install [opções]
  kitt-reverse-proxy gateway jetbrains uninstall
  kitt-reverse-proxy gateway jetbrains show
  kitt-reverse-proxy gateway verify [--base-url http://127.0.0.1:3000]
  kitt-reverse-proxy gateway env <codex|claude|openai|ollama> [opções]

Opções:
  --base-url <url>          default: ${DEFAULT_GATEWAY_BASE}
  --openai-model <id>       default: ${DEFAULT_OPENAI_MODEL}
  --anthropic-model <id>    default: ${DEFAULT_ANTHROPIC_MODEL}
  --api-key <valor>         chave do proxy; fallback: PROXY_API_KEY; sem chave usa sentinel local
  --reveal-secrets          permite que "gateway env" imprima secrets explicitamente
  --with-opencode           instala entrada KITT · OpenCode em acp.json
`);
}

export async function runGatewayCli(argv: string[]): Promise<number> {
  const [command, subcommand] = argv;
  if (!command || has(argv, '--help') || has(argv, '-h')) {
    printGatewayHelp();
    return 0;
  }

  if (command === 'env') {
    if (!subcommand) throw new Error('Informe o protocolo/agente.');
    const options = parseGatewayOptions(argv.slice(2));
    const env = buildAgentEnvironment(subcommand, options, process.env);
    console.log(JSON.stringify(options.revealSecrets ? env : redactedEnvironment(env), null, 2));
    return 0;
  }

  if (command === 'verify') {
    const options = parseGatewayOptions(argv.slice(1));
    console.log(JSON.stringify(await verifyGateway(options.baseUrl), null, 2));
    return 0;
  }

  if (command === 'agent') {
    if (!subcommand) throw new Error('Informe codex, claude ou opencode.');
    const options = parseGatewayOptions(argv.slice(2));
    const profile = defaultAgentCommand(subcommand);
    const env = buildAgentEnvironment(subcommand, options);
    return await spawnAndWait(profile.command, profile.args, env);
  }

  if (command === 'exec') {
    if (!subcommand) throw new Error('Informe protocolo/agente para o ambiente.');
    const separator = argv.indexOf('--');
    if (separator < 0 || !argv[separator + 1]) throw new Error('Use -- antes do comando filho.');
    const options = parseGatewayOptions(argv.slice(2, separator));
    const childCommand = argv[separator + 1]!;
    const childArgs = argv.slice(separator + 2);
    return await spawnAndWait(childCommand, childArgs, buildAgentEnvironment(subcommand, options));
  }

  if (command === 'jetbrains') {
    const action = subcommand;
    const rest = argv.slice(2);
    const common = parseGatewayOptions(rest);
    const options: GatewayOptions = {
      ...common,
      opencode: has(rest, '--with-opencode'),
      path: valueAfter(rest, '--path', undefined),
      executable: valueAfter(rest, '--executable', undefined),
    };
    if (action === 'install') {
      console.log(JSON.stringify(await installJetBrains(options), null, 2));
      return 0;
    }
    if (action === 'uninstall') {
      console.log(JSON.stringify(await uninstallJetBrains(options), null, 2));
      return 0;
    }
    if (action === 'show') {
      const path = options.path || join(homedir(), '.jetbrains', 'acp.json');
      console.log(JSON.stringify(await readJson(path, {}), null, 2));
      return 0;
    }
    throw new Error('Use jetbrains install|uninstall|show.');
  }

  throw new Error(`Comando desconhecido: ${command}`);
}
