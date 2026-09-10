import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';
import { RESOURCE_LIMITS } from '../core/resource-limits.js';

const DEFAULT_LOCAL_KEY = 'kitt-local';
export const DEFAULT_GATEWAY_BASE = 'http://127.0.0.1:3000';
export const DEFAULT_OPENAI_MODEL = 'chatgpt-web';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-web';

const DIRECT_PROVIDER_ENV = [
  'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_API_HOST',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_URL', 'OLLAMA_HOST',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEDROCK_BASE_URL', 'VERTEX_BASE_URL'
];
const SECRET_ENV = new Set([
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'PROXY_API_KEY'
]);

export interface GatewayOptions {
  baseUrl?: string;
  openaiModel?: string;
  anthropicModel?: string;
  apiKey?: string;
  codex?: boolean;
  claude?: boolean;
  opencode?: boolean;
  path?: string;
  executable?: string;
  revealSecrets?: boolean;
}

export function normalizeBaseUrl(value?: string): string {
  const url = new URL(value || DEFAULT_GATEWAY_BASE);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Gateway URL deve usar http/https.');
  if (url.username || url.password) throw new Error('Gateway URL não pode conter credenciais.');
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('KITT-only exige gateway em loopback.');
  }
  if (url.search || url.hash) throw new Error('Gateway URL não pode conter query string ou fragmento.');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Gateway URL deve apontar para a raiz do proxy, sem path adicional.');
  return url.toString().replace(/\/$/, '');
}

function openAiBase(base: string): string {
  return `${base}/v1`;
}

function cleanEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of DIRECT_PROVIDER_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^JETBRAINS_AI/i.test(key) || /^JB_AI_/i.test(key)) delete env[key];
  }
  const extra = [dirname(process.execPath), join(homedir(), '.local', 'bin'), join(homedir(), '.opencode', 'bin')];
  env.PATH = [...extra, env.PATH || ''].filter(Boolean).join(delimiter);
  return env;
}

export function buildAgentEnvironment(
  agent: string,
  options: GatewayOptions = {},
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const base = normalizeBaseUrl(options.baseUrl);
  const openaiModel = options.openaiModel || DEFAULT_OPENAI_MODEL;
  const anthropicModel = options.anthropicModel || DEFAULT_ANTHROPIC_MODEL;
  const env = cleanEnvironment(baseEnv);
  const apiKey = options.apiKey || baseEnv.PROXY_API_KEY || DEFAULT_LOCAL_KEY;

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

function findExecutable(command: string): string {
  try {
    const lookup = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(lookup, [command], { encoding: 'utf8', windowsHide: true });
    const first = result.status === 0 ? result.stdout.split(/\r?\n/).map((item) => item.trim()).find(Boolean) : undefined;
    return first || command;
  } catch {
    return command;
  }
}

export function defaultAgentCommand(agent: string): { command: string; args: string[] } {
  switch (agent) {
    case 'codex': return { command: findExecutable('codex-acp'), args: [] };
    case 'claude': return { command: findExecutable('claude-agent-acp'), args: [] };
    case 'opencode': return { command: findExecutable('opencode'), args: ['acp'] };
    default: throw new Error(`Agent desconhecido: ${agent}`);
  }
}

export async function spawnAndWait(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit', shell: false, windowsHide: false });
    const forward = (signal: NodeJS.Signals): void => {
      if (!child.killed) child.kill(signal);
    };
    const cleanup = (): void => {
      process.removeListener('SIGINT', forward);
      process.removeListener('SIGTERM', forward);
    };
    process.once('SIGINT', forward);
    process.once('SIGTERM', forward);
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : (code ?? 1));
    });
  });
}

function gatewayArgs(options: { baseUrl: string; openaiModel: string; anthropicModel: string }): string[] {
  return ['--base-url', options.baseUrl, '--openai-model', options.openaiModel, '--anthropic-model', options.anthropicModel];
}

export function buildJetBrainsEntries(
  executable: string,
  options: GatewayOptions = {}
): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const openaiModel = options.openaiModel || DEFAULT_OPENAI_MODEL;
  const anthropicModel = options.anthropicModel || DEFAULT_ANTHROPIC_MODEL;
  const args = gatewayArgs({ baseUrl, openaiModel, anthropicModel });
  const pathValue = [dirname(process.execPath), join(homedir(), '.local', 'bin'), join(homedir(), '.opencode', 'bin'), process.env.PATH || '']
    .filter(Boolean).join(delimiter);
  const env = { KITT_ONLY: '1', PATH: pathValue };
  const entries: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  if (options.codex !== false) entries['KITT · Codex'] = { command: executable, args: ['agent', 'codex', ...args], env };
  if (options.claude !== false) entries['KITT · Claude'] = { command: executable, args: ['agent', 'claude', ...args], env };
  if (options.opencode) entries['KITT · OpenCode'] = { command: executable, args: ['agent', 'opencode', ...args], env };
  return entries;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const text = await readFile(path, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > RESOURCE_LIMITS.gatewayJsonBytes) throw new Error('arquivo excede o limite permitido');
    return JSON.parse(text) as T;
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === 'ENOENT') return fallback;
    throw new Error(`${path}: JSON inválido: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  if (process.platform !== 'win32') await chmod(path, 0o600);
}

export async function installJetBrains(options: GatewayOptions = {}): Promise<{ configPath: string; installed: string[] }> {
  const configPath = options.path || join(homedir(), '.jetbrains', 'acp.json');
  const executable = options.executable || findExecutable('kitt-agent-gateway');
  const current = await readJson<Record<string, unknown>>(configPath, { default_mcp_settings: {}, agent_servers: {} });
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('acp.json precisa ser um objeto.');
  const servers = current.agent_servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) current.agent_servers = {};
  const entries = buildJetBrainsEntries(executable, options);
  current.agent_servers = { ...(current.agent_servers as Record<string, unknown>), ...entries };
  await writeJsonAtomic(configPath, current);
  return { configPath, installed: Object.keys(entries) };
}

export async function uninstallJetBrains(options: GatewayOptions = {}): Promise<{ configPath: string; removed: string[] }> {
  const configPath = options.path || join(homedir(), '.jetbrains', 'acp.json');
  const current = await readJson<Record<string, unknown>>(configPath, { default_mcp_settings: {}, agent_servers: {} });
  const servers = current.agent_servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return { configPath, removed: [] };
  const map = servers as Record<string, unknown>;
  const removed: string[] = [];
  for (const name of ['KITT · Codex', 'KITT · Claude', 'KITT · OpenCode']) {
    if (Object.prototype.hasOwnProperty.call(map, name)) { delete map[name]; removed.push(name); }
  }
  await writeJsonAtomic(configPath, current);
  return { configPath, removed };
}

async function requestJson(url: string, apiKey?: string): Promise<Record<string, any>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      }
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw, 'utf8') > RESOURCE_LIMITS.gatewayJsonBytes) throw new Error('Resposta do gateway excede o limite permitido.');
    const body = raw ? JSON.parse(raw) as Record<string, any> : {};
    if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyGateway(baseUrl = DEFAULT_GATEWAY_BASE, apiKey?: string): Promise<{
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
    requestJson(`${base}/v1/capabilities`, apiKey),
    requestJson(`${base}/v1/models`, apiKey)
  ]);
  const modelIds = Array.isArray(models.data)
    ? models.data.map((item: any) => item?.id).filter((value: unknown): value is string => typeof value === 'string')
    : [];
  return {
    status: 'ok', base_url: base,
    openai: Boolean(caps.protocols?.openai?.chat_completions),
    responses: Boolean(caps.protocols?.openai?.responses),
    anthropic: Boolean(caps.protocols?.anthropic?.messages),
    tools: Boolean(caps.protocols?.openai?.tools),
    models: modelIds
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
  const out = { ...env };
  for (const key of SECRET_ENV) if (out[key]) out[key] = '<redacted>';
  return out;
}

export function printGatewayHelp(): void {
  console.log(`\nkitt-reverse-proxy gateway / kitt-agent-gateway\n\nUso:\n  kitt-reverse-proxy gateway agent codex|claude|opencode [opções]\n  kitt-reverse-proxy gateway exec <codex|claude|openai|ollama> [opções] -- <comando> [args...]\n  kitt-reverse-proxy gateway jetbrains install|uninstall|show [opções]\n  kitt-reverse-proxy gateway verify [opções]\n  kitt-reverse-proxy gateway env <protocolo> [opções]\n\nOpções:\n  --base-url <url>\n  --openai-model <id>\n  --anthropic-model <id>\n  --api-key <valor>\n  --reveal-secrets\n  --with-opencode\n`);
}

export async function runGatewayCli(argv: string[]): Promise<number> {
  const [command, subcommand] = argv;
  if (!command || has(argv, '--help') || has(argv, '-h')) { printGatewayHelp(); return 0; }

  if (command === 'env') {
    if (!subcommand) throw new Error('Informe o protocolo/agente.');
    const options = parseGatewayOptions(argv.slice(2));
    const env = buildAgentEnvironment(subcommand, options);
    console.log(JSON.stringify(options.revealSecrets ? env : redactedEnvironment(env), null, 2));
    return 0;
  }
  if (command === 'verify') {
    const options = parseGatewayOptions(argv.slice(1));
    console.log(JSON.stringify(await verifyGateway(options.baseUrl, options.apiKey), null, 2));
    return 0;
  }
  if (command === 'agent') {
    if (!subcommand) throw new Error('Informe codex, claude ou opencode.');
    const options = parseGatewayOptions(argv.slice(2));
    const profile = defaultAgentCommand(subcommand);
    return await spawnAndWait(profile.command, profile.args, buildAgentEnvironment(subcommand, options));
  }
  if (command === 'exec') {
    if (!subcommand) throw new Error('Informe protocolo/agente para o ambiente.');
    const separator = argv.indexOf('--');
    if (separator < 0 || !argv[separator + 1]) throw new Error('Use -- antes do comando filho.');
    const options = parseGatewayOptions(argv.slice(2, separator));
    return await spawnAndWait(argv[separator + 1]!, argv.slice(separator + 2), buildAgentEnvironment(subcommand, options));
  }
  if (command === 'jetbrains') {
    const rest = argv.slice(2);
    const common = parseGatewayOptions(rest);
    const options: GatewayOptions = {
      ...common,
      opencode: has(rest, '--with-opencode'),
      path: valueAfter(rest, '--path'),
      executable: valueAfter(rest, '--executable')
    };
    if (subcommand === 'install') { console.log(JSON.stringify(await installJetBrains(options), null, 2)); return 0; }
    if (subcommand === 'uninstall') { console.log(JSON.stringify(await uninstallJetBrains(options), null, 2)); return 0; }
    if (subcommand === 'show') {
      const path = options.path || join(homedir(), '.jetbrains', 'acp.json');
      console.log(JSON.stringify(await readJson(path, {}), null, 2));
      return 0;
    }
    throw new Error('Use jetbrains install|uninstall|show.');
  }

  throw new Error(`Comando desconhecido: ${command}`);
}
