import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliLaunchPresets } from '../config.js';
import { providerRegistry } from '../plugins/registry.js';
import { InstanceRegistry, normalizeInstanceId, processAlive, type ProxyInstanceRecord } from './instance-registry.js';
import { ProfileRegistry } from './profile-registry.js';

export interface ResolvedServiceTarget {
  input: string;
  targetUrl: string;
  provider: string;
  model: string;
}

export interface StartServiceOptions {
  target: string;
  id?: string;
  profile?: string;
  port?: number;
  host?: string;
}

export interface ServiceStatus extends ProxyInstanceRecord {
  status: 'ready' | 'running' | 'unhealthy';
}

export function resolveServiceTarget(input: string): ResolvedServiceTarget {
  const value = input.trim();
  const preset = cliLaunchPresets().find((item) => item.id === value.toLowerCase());
  if (preset) {
    return {
      input: preset.id,
      targetUrl: preset.targetUrl,
      provider: preset.id,
      model: preset.apiModel
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Unknown provider preset or URL: ${value}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Service target must be an http(s) URL without embedded credentials.');
  }
  const provider = providerRegistry.detect(url.toString(), 'auto');
  return {
    input: url.toString(),
    targetUrl: url.toString(),
    provider: provider.id,
    model: provider.defaultApiModel
  };
}

async function portAvailable(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export class ServiceManager {
  readonly profiles: ProfileRegistry;
  readonly instances: InstanceRegistry;
  private readonly root: string;

  constructor(root = join(homedir(), '.kitt-reverse-proxy')) {
    this.root = root;
    this.profiles = new ProfileRegistry(root);
    this.instances = new InstanceRegistry(root);
  }

  async list(): Promise<ServiceStatus[]> {
    const active = this.instances.listActive();
    return await Promise.all(active.map(async (instance) => ({
      ...instance,
      status: await this.health(instance)
    })));
  }

  async start(options: StartServiceOptions): Promise<ProxyInstanceRecord> {
    const target = resolveServiceTarget(options.target);
    const profile = this.profiles.resolve(target.provider, options.profile);
    const active = this.instances.listActive();

    const owner = active.find((instance) => instance.profileDirectory === profile.directory);
    if (owner) {
      throw new Error(
        `Browser profile ${profile.id} is already used by instance ${owner.id}. Stop it or choose another profile.`
      );
    }

    const host = options.host?.trim() || '127.0.0.1';
    const port = await this.allocatePort(host, options.port, active);
    const id = normalizeInstanceId(options.id || `${target.provider}-${port}`);
    if (active.some((instance) => instance.id === id)) {
      throw new Error(`Reverse-proxy instance already running: ${id}`);
    }

    const logs = join(this.root, 'logs');
    mkdirSync(logs, { recursive: true });
    const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
    const args = [
      cliPath,
      target.input,
      '--provider', target.provider,
      '--transport', 'ui',
      '--api-model', target.model,
      '--host', host,
      '--port', String(port),
      '--user-data-dir', profile.directory,
      '--log-file', join(logs, `${id}.log`)
    ];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, KITT_CONTROL_PLANE_CHILD: '1' }
    });
    child.unref();
    if (!child.pid) throw new Error('Could not obtain reverse-proxy process id.');

    const record: ProxyInstanceRecord = {
      id,
      provider: target.provider,
      model: target.model,
      target: target.input,
      profileId: profile.id,
      profileDirectory: profile.directory,
      host,
      port,
      pid: child.pid,
      startedAt: new Date().toISOString()
    };
    this.profiles.markProvider(profile.id, target.provider);
    return this.instances.put(record);
  }

  async stop(id: string): Promise<boolean> {
    const instance = this.instances.get(id);
    if (!instance) return false;
    if (processAlive(instance.pid)) {
      try {
        process.kill(instance.pid, 'SIGTERM');
      } catch {
        // The process may have exited between discovery and signal delivery.
      }
      await waitForExit(instance.pid, 2_500);
      if (processAlive(instance.pid)) {
        try {
          process.kill(instance.pid, 'SIGKILL');
        } catch {
          // Best-effort final termination.
        }
      }
    }
    this.instances.remove(instance.id);
    return true;
  }

  async stopAll(): Promise<number> {
    const active = this.instances.listActive();
    let stopped = 0;
    for (const instance of active) {
      if (await this.stop(instance.id)) stopped += 1;
    }
    return stopped;
  }

  async restart(id: string): Promise<ProxyInstanceRecord> {
    const instance = this.instances.get(id);
    if (!instance) throw new Error(`Unknown reverse-proxy instance: ${id}`);
    await this.stop(instance.id);
    return await this.start({
      target: instance.target,
      id: instance.id,
      profile: instance.profileId,
      port: instance.port,
      host: instance.host
    });
  }

  private async allocatePort(
    host: string,
    requested: number | undefined,
    active: readonly ProxyInstanceRecord[]
  ): Promise<number> {
    if (requested !== undefined) {
      if (!Number.isInteger(requested) || requested < 1 || requested > 65_535) {
        throw new Error('Port must be between 1 and 65535.');
      }
      if (active.some((instance) => instance.host === host && instance.port === requested)) {
        throw new Error(`Port already owned by another KITT reverse-proxy instance: ${requested}`);
      }
      if (!await portAvailable(host, requested)) throw new Error(`Port is unavailable: ${requested}`);
      return requested;
    }

    for (let port = 3000; port <= 3099; port += 1) {
      if (active.some((instance) => instance.host === host && instance.port === port)) continue;
      if (await portAvailable(host, port)) return port;
    }
    throw new Error('No free reverse-proxy port found in range 3000-3099.');
  }

  private async health(instance: ProxyInstanceRecord): Promise<ServiceStatus['status']> {
    try {
      const response = await fetch(`http://${instance.host}:${instance.port}/readyz`, {
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) return 'ready';
      return 'unhealthy';
    } catch {
      return 'running';
    }
  }
}
