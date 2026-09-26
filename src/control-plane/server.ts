import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { loadProviderPluginModules } from '../plugins/loader.js';
import { providerRegistry } from '../plugins/registry.js';
import { ProfileRegistry } from './profile-registry.js';
import { ServiceManager } from './service-manager.js';

const CONTROL_HOST = '127.0.0.1';
const DEFAULT_CONTROL_PORT = 2999;
const MAX_REQUEST_BYTES = 64 * 1024;

export interface ControlRequest {
  action: string;
  params?: Record<string, unknown>;
}

export function controlPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.KITT_REVERSE_PROXY_CONTROL_PORT || DEFAULT_CONTROL_PORT);
  if (!Number.isInteger(raw) || raw < 1 || raw > 65_535) {
    throw new Error('KITT_REVERSE_PROXY_CONTROL_PORT must be an integer between 1 and 65535.');
  }
  return raw;
}

let pluginLoad: Promise<void> | undefined;

async function ensureProviderPlugins(): Promise<void> {
  if (!pluginLoad) {
    const configured = (process.env.PROXY_PROVIDER_PLUGINS || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    pluginLoad = configured.length
      ? loadProviderPluginModules([...new Set(configured)]).then(() => undefined)
      : Promise.resolve();
  }
  await pluginLoad;
}

function paramsOf(request: ControlRequest): Record<string, unknown> {
  return request.params && typeof request.params === 'object' ? request.params : {};
}

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing control parameter: ${name}`);
  return value.trim();
}

function optionalString(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalPort(params: Record<string, unknown>): number | undefined {
  const value = params.port;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('Control parameter port must be an integer.');
  return value;
}

export async function dispatchControlRequest(
  request: ControlRequest,
  root?: string
): Promise<Record<string, unknown>> {
  const params = paramsOf(request);
  await ensureProviderPlugins();

  if (request.action === 'plugins.list') {
    const plugins = providerRegistry.records.map(({ plugin, source }) => ({
      id: plugin.provider.id,
      name: plugin.provider.name,
      version: plugin.version,
      source,
      default_url: plugin.provider.ui.newChatUrl ?? null,
      default_model: plugin.provider.defaultApiModel,
      transports: [...plugin.provider.transports],
      auth: plugin.provider.auth
    }));
    return { schema_version: 1, plugins };
  }

  const profiles = new ProfileRegistry(root);
  profiles.importLegacy(providerRegistry.ids());

  if (request.action === 'profiles.list') {
    return { schema_version: 1, profiles: profiles.list() };
  }
  if (request.action === 'profiles.create') {
    const provider = optionalString(params, 'provider');
    const profile = profiles.create(requiredString(params, 'name'), provider ? [provider] : []);
    return { schema_version: 1, profile };
  }
  if (request.action === 'profiles.remove') {
    const id = requiredString(params, 'id');
    const removed = profiles.remove(id, params.delete_data === true);
    return { schema_version: 1, id, removed };
  }

  const services = new ServiceManager(root);
  if (request.action === 'service.list') {
    return { schema_version: 1, instances: await services.list() };
  }
  if (request.action === 'service.start') {
    const options: {
      target: string;
      profile?: string;
      id?: string;
      port?: number;
      host?: string;
    } = { target: requiredString(params, 'target') };
    const profile = optionalString(params, 'profile');
    const id = optionalString(params, 'id');
    const host = optionalString(params, 'host');
    const port = optionalPort(params);
    if (profile) options.profile = profile;
    if (id) options.id = id;
    if (host) options.host = host;
    if (port !== undefined) options.port = port;
    return { schema_version: 1, instance: await services.start(options) };
  }
  if (request.action === 'service.stop') {
    const id = requiredString(params, 'id');
    return { schema_version: 1, id, stopped: await services.stop(id) };
  }
  if (request.action === 'service.stopAll') {
    return { schema_version: 1, stopped: await services.stopAll() };
  }
  if (request.action === 'service.restart') {
    const id = requiredString(params, 'id');
    return { schema_version: 1, instance: await services.restart(id) };
  }

  throw new Error(`Unknown control action: ${request.action}`);
}

async function readJson(req: IncomingMessage): Promise<ControlRequest> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('Control request body is too large.');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(raw || '{}') as Partial<ControlRequest>;
  if (typeof parsed.action !== 'string' || !parsed.action.trim()) {
    throw new Error('Control request action is required.');
  }
  return { action: parsed.action.trim(), ...(parsed.params ? { params: parsed.params } : {}) };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

export async function startControlServer(port = controlPort()): Promise<Server> {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/healthz') {
        json(res, 200, { schema_version: 1, status: 'ok', pid: process.pid });
        return;
      }
      if (req.method === 'POST' && req.url === '/shutdown') {
        json(res, 200, { schema_version: 1, stopping: true, pid: process.pid });
        setImmediate(() => server.close());
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/control') {
        json(res, 404, { schema_version: 1, error: 'not_found' });
        return;
      }
      try {
        json(res, 200, await dispatchControlRequest(await readJson(req)));
      } catch (error) {
        json(res, 400, {
          schema_version: 1,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();
  });

  return await new Promise<Server>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, CONTROL_HOST, () => resolve(server));
  });
}

export async function controlServerReady(port = controlPort()): Promise<boolean> {
  try {
    const response = await fetch(`http://${CONTROL_HOST}:${port}/healthz`, {
      signal: AbortSignal.timeout(250)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureControlServer(port = controlPort()): Promise<{
  ready: boolean;
  started: boolean;
  pid?: number;
}> {
  if (await controlServerReady(port)) return { ready: true, started: false };

  const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
  const child = spawn(process.execPath, [cliPath, 'control', 'serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, KITT_REVERSE_PROXY_CONTROL_PORT: String(port) }
  });
  child.unref();

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await controlServerReady(port)) {
      return {
        ready: true,
        started: true,
        ...(child.pid ? { pid: child.pid } : {})
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    ready: false,
    started: true,
    ...(child.pid ? { pid: child.pid } : {})
  };
}

export async function stopControlServer(port = controlPort()): Promise<boolean> {
  try {
    const response = await fetch(`http://${CONTROL_HOST}:${port}/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(500)
    });
    return response.ok;
  } catch {
    return false;
  }
}
