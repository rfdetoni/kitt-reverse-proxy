import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cliLaunchPresets } from '../config.js';
import { decisionSettingsFromEnv, type DecisionMode } from '../decision/ollaya.js';
import type { TemporaryChatMode } from '../runtime/temporary-chat.js';
import { providerRegistry } from '../plugins/registry.js';
import { withFileLock } from './file-lock.js';
import { InstanceRegistry, normalizeInstanceId, type ProxyInstanceRecord } from './instance-registry.js';
import { processFingerprint, processMatches } from './process-identity.js';
import { ProfileRegistry } from './profile-registry.js';

export interface ResolvedServiceTarget {
  input: string;
  targetUrl: string;
  provider: string;
  model: string;
}

export interface ServiceModelOptions {
  decisionMode?: DecisionMode;
  decisionModel?: string;
  decisionUrl?: string;
  decisionTimeoutMs?: number;
  temporaryChat?: TemporaryChatMode;
}

export interface StartServiceOptions extends ServiceModelOptions {
  target: string;
  /** API model alias; browser UI selection remains the provider's responsibility. */
  model?: string;
  id?: string;
  profile?: string;
  port?: number;
  host?: string;
  logLevel?: 0 | 1 | 2;
  logContent?: 'none' | 'metadata' | 'full';
  logFile?: string;
  ownerPid?: number;
}

export interface ServiceStatus extends ProxyInstanceRecord {
  status: 'ready' | 'running' | 'unhealthy';
}

/** Validate everything before stopping an existing managed proxy. */
export function validateServiceModels(options: Partial<StartServiceOptions>): void {
  for (const [key, value] of [['model', options.model], ['decisionModel', options.decisionModel]] as const) {
    if (value !== undefined && (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value))) {
      throw new Error(key + ' must be a model identifier (1-256 characters).');
    }
  }
  if (options.temporaryChat !== undefined && !['off', 'supported', 'required'].includes(options.temporaryChat)) {
    throw new Error('temporaryChat must be off, supported or required.');
  }
  if (options.decisionMode !== undefined && !['off', 'shadow', 'assist'].includes(options.decisionMode)) {
    throw new Error('decisionMode must be off, shadow or assist.');
  }
  if (options.decisionTimeoutMs !== undefined && (
    !Number.isInteger(options.decisionTimeoutMs) || options.decisionTimeoutMs < 100 || options.decisionTimeoutMs > 30000
  )) throw new Error('decisionTimeoutMs must be between 100 and 30000.');
  if (options.decisionUrl !== undefined || options.decisionMode !== undefined || options.decisionTimeoutMs !== undefined) {
    // Same origin, timeout and mode constraints as the execution adapter.
    decisionSettingsFromEnv({
      PROXY_DECISION_MODE: options.decisionMode ?? 'off',
      PROXY_DECISION_URL: options.decisionUrl ?? 'http://127.0.0.1:11435',
      PROXY_DECISION_TIMEOUT_MS: String(options.decisionTimeoutMs ?? 2500)
    });
  }
}

export function buildManagedProxyArgs(input: {
  cliPath: string;
  target: ResolvedServiceTarget;
  host: string;
  port: number;
  profileDirectory: string;
  browserHostCdpPort?: number;
  logLevel: 0 | 1 | 2;
  logContent: 'none' | 'metadata' | 'full';
  logFile: string;
  ownerPid?: number;
  ownerFingerprint?: string;
}): string[] {
  return [
    input.cliPath,
    input.target.input,
    '--provider', input.target.provider,
    '--transport', 'ui',
    '--api-model', input.target.model,
    '--host', input.host,
    '--port', String(input.port),
    ...(input.browserHostCdpPort
      ? ['--cdp-url', `http://127.0.0.1:${input.browserHostCdpPort}`, '--user-data-dir', input.profileDirectory]
      : ['--user-data-dir', input.profileDirectory]),
    '--log-level', String(input.logLevel),
    '--log-content', input.logContent,
    '--log-file', input.logFile,
    ...(input.ownerPid ? ['--owner-pid', String(input.ownerPid)] : []),
    ...(input.ownerFingerprint ? ['--owner-fingerprint', input.ownerFingerprint] : [])
  ];
}

export const SERVICE_READY_TIMEOUT_MS = 330_000;

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

async function waitForFingerprint(pid: number, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fingerprint = processFingerprint(pid);
    if (fingerprint) return fingerprint;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Could not establish process identity for pid ' + pid + '.');
}

async function waitForExit(pid: number, fingerprint: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processMatches(pid, fingerprint) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function httpHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
}

async function waitForServiceReady(
  host: string,
  port: number,
  pid: number,
  fingerprint: string,
  timeoutMs = SERVICE_READY_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 40;
  while (Date.now() < deadline) {
    if (!processMatches(pid, fingerprint)) {
      throw new Error('Reverse-proxy process exited before HTTP readiness.');
    }
    try {
      const response = await fetch('http://' + httpHost(host) + ':' + port + '/healthz', {
        signal: AbortSignal.timeout(Math.min(750, Math.max(150, delayMs * 2)))
      });
      if (response.ok) return;
    } catch {
      // Listener may still be binding.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(400, Math.ceil(delayMs * 1.5));
  }
  throw new Error('Timed out waiting for reverse-proxy HTTP readiness.');
}

export function browserHostPoolEnabled(
  provider: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  // Both can authenticate through Google; pooling attaches before human login.
  if (provider === 'gemini' || provider === 'chatgpt') return false;
  const raw = (env.PROXY_BROWSER_HOST_POOL || 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

export function canReuseBrowserHost(
  owner: ProxyInstanceRecord | undefined,
  provider: string,
  matches: (pid: number, fingerprint: string | undefined) => boolean = processMatches
): boolean {
  return Boolean(
    owner
    && browserHostPoolEnabled(provider)
    && owner.browserHostPid
    && owner.browserHostFingerprint
    && owner.browserHostCdpPort
    && matches(owner.browserHostPid, owner.browserHostFingerprint)
  );
}

async function waitForCdpReady(
  port: number,
  pid: number,
  fingerprint: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 50;
  while (Date.now() < deadline) {
    if (!processMatches(pid, fingerprint)) throw new Error('Browser host exited before CDP became ready.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(Math.min(750, Math.max(150, delayMs * 2)))
      });
      if (response.ok) return;
    } catch {
      // Browser host is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    delayMs = Math.min(500, Math.ceil(delayMs * 1.6));
  }
  throw new Error('Timed out waiting for shared browser host CDP readiness.');
}

function terminateOwnedProcess(
  pid: number,
  fingerprint: string | undefined,
  signal: NodeJS.Signals = 'SIGTERM'
): boolean {
  if (!fingerprint || !processMatches(pid, fingerprint)) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function terminateSpawnedOwned(
  child: ChildProcess | undefined,
  fingerprint: string | undefined
): void {
  if (!child?.pid || !fingerprint) return;
  terminateOwnedProcess(child.pid, fingerprint);
}

export class ServiceManager {
  readonly profiles: ProfileRegistry;
  readonly instances: InstanceRegistry;
  private readonly root: string;
  private readonly profileLocks = new Map<string, Promise<void>>();

  constructor(root = join(homedir(), '.kitt-reverse-proxy')) {
    this.root = root;
    this.profiles = new ProfileRegistry(root);
    this.instances = new InstanceRegistry(root);
  }

  async withControlLock<T>(operation: () => Promise<T> | T): Promise<T> {
    return await withFileLock(this.root, 'services', operation, 30_000);
  }

  async list(): Promise<ServiceStatus[]> {
    this.reapOrphanBrowserHosts();
    const active = this.instances.listActive();
    return await Promise.all(active.map(async (instance) => ({
      ...instance,
      status: await this.health(instance)
    })));
  }

  async start(options: StartServiceOptions): Promise<ProxyInstanceRecord> {
    validateServiceModels(options);
    return await this.withControlLock(() => this.startUnlocked(options));
  }

  private async startUnlocked(options: StartServiceOptions): Promise<ProxyInstanceRecord> {
    this.reapOrphanBrowserHosts();
    const target = resolveServiceTarget(options.target);
    const profile = this.profiles.resolve(target.provider, options.profile);
    // Persisted per-provider choices survive service stop, restart and KITT restarts.
    options = { ...this.profiles.modelSettings(profile.id, target.provider), ...options };
    validateServiceModels(options);
    if (options.model) target.model = options.model;
    if (options.temporaryChat === 'required' && target.provider !== 'chatgpt') {
      throw new Error('Verified temporary chat is currently supported only for ChatGPT.');
    }
    return await this.withProfileLock(profile.directory, async () => {
    const active = this.instances.listActive();

    const pooling = browserHostPoolEnabled(target.provider);
    const owner = active.find((instance) => instance.profileDirectory === profile.directory);
    if (owner && !canReuseBrowserHost(owner, target.provider)) {
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
    const requestedLogFile = options.logFile?.trim();
    const serviceLogFile = requestedLogFile
      ? join(dirname(requestedLogFile), `reverse-proxy-${id}.log`)
      : join(logs, `${id}.log`);
    mkdirSync(dirname(serviceLogFile), { recursive: true });
    const logLevel = options.logLevel ?? 0;
    const logContent = options.logContent ?? (logLevel >= 2 ? 'full' : 'metadata');
    const ownerPid = Number.isInteger(options.ownerPid) && Number(options.ownerPid) > 0
      ? Number(options.ownerPid)
      : undefined;
    const ownerFingerprint = ownerPid
      ? processFingerprint(ownerPid)
      : undefined;
    if (ownerPid && !ownerFingerprint) {
      throw new Error('Could not establish managed Agent process identity.');
    }
    const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));
    let browserHostPid = owner?.browserHostPid;
    let browserHostFingerprint = owner?.browserHostFingerprint;
    let browserHostCdpPort = owner?.browserHostCdpPort;
    let browserHostChild: ChildProcess | undefined;
    let startedBrowserHost = false;

    if (browserHostPid && browserHostFingerprint && browserHostCdpPort) {
      await waitForCdpReady(browserHostCdpPort, browserHostPid, browserHostFingerprint);
    } else if (pooling) {
      browserHostCdpPort = await this.allocateBrowserHostPort(active);
      browserHostChild = spawn(
        process.execPath,
        [
          cliPath,
          'browser-host',
          'serve',
          '--profile', profile.directory,
          '--target', target.targetUrl,
          '--cdp-port', String(browserHostCdpPort)
        ],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: { ...process.env, KITT_CONTROL_PLANE_CHILD: '1', ...(browserHostPid ? { KITT_SHARED_BROWSER_PID: String(browserHostPid) } : {}) }
        }
      );
      browserHostChild.unref();
      if (!browserHostChild.pid) throw new Error('Could not obtain browser host process id.');
      browserHostPid = browserHostChild.pid;
      try {
        browserHostFingerprint = await waitForFingerprint(browserHostPid);
        startedBrowserHost = true;
        await waitForCdpReady(browserHostCdpPort, browserHostPid, browserHostFingerprint);
      } catch {
        // BrowserHost pooling is an optimization. Roll back only the child
        // created by this start attempt and retain the process-owned fallback.
        terminateSpawnedOwned(browserHostChild, browserHostFingerprint);
        browserHostPid = undefined;
        browserHostFingerprint = undefined;
        browserHostCdpPort = undefined;
        browserHostChild = undefined;
        startedBrowserHost = false;
      }
    }

    const args = buildManagedProxyArgs({
      cliPath,
      target,
      host,
      port,
      profileDirectory: profile.directory,
      ...(browserHostPid && browserHostCdpPort ? { browserHostCdpPort } : {}),
      logLevel,
      logContent,
      logFile: serviceLogFile,
      ...(ownerPid ? { ownerPid } : {}),
      ...(ownerFingerprint ? { ownerFingerprint } : {})
    });
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        KITT_CONTROL_PLANE_CHILD: '1',
        ...(options.decisionMode !== undefined ? { PROXY_DECISION_MODE: options.decisionMode } : {}),
        ...(options.decisionModel !== undefined ? { PROXY_DECISION_MODEL: options.decisionModel } : {}),
        ...(options.decisionUrl !== undefined ? { PROXY_DECISION_URL: options.decisionUrl } : {}),
        ...(options.decisionTimeoutMs !== undefined ? { PROXY_DECISION_TIMEOUT_MS: String(options.decisionTimeoutMs) } : {}),
        ...(options.temporaryChat !== undefined ? { PROXY_TEMPORARY_CHAT: options.temporaryChat } : {}),
        ...(browserHostPid ? { KITT_SHARED_BROWSER_PID: String(browserHostPid) } : {})
      }
    });
    child.unref();
    if (!child.pid) {
      if (startedBrowserHost) terminateSpawnedOwned(browserHostChild, browserHostFingerprint);
      throw new Error('Could not obtain reverse-proxy process id.');
    }

    let serviceFingerprint: string | undefined;
    try {
      serviceFingerprint = await waitForFingerprint(child.pid);
      await waitForServiceReady(host, port, child.pid, serviceFingerprint);
    } catch (error) {
      terminateSpawnedOwned(child, serviceFingerprint);
      if (startedBrowserHost) terminateSpawnedOwned(browserHostChild, browserHostFingerprint);
      throw error;
    }

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
      processFingerprint: serviceFingerprint!,
      startedAt: new Date().toISOString(),
      ...(options.decisionMode !== undefined ? { decisionMode: options.decisionMode } : {}),
      ...(options.decisionModel !== undefined ? { decisionModel: options.decisionModel } : {}),
      ...(options.decisionUrl !== undefined ? { decisionUrl: options.decisionUrl } : {}),
      ...(options.decisionTimeoutMs !== undefined ? { decisionTimeoutMs: options.decisionTimeoutMs } : {}),
      ...(options.temporaryChat !== undefined ? { temporaryChat: options.temporaryChat } : {}),
      logLevel,
      logContent,
      logFile: serviceLogFile,
      ...(ownerPid ? { ownerPid } : {}),
      ...(ownerFingerprint ? { ownerFingerprint } : {}),
      ...(browserHostPid && browserHostFingerprint && browserHostCdpPort
        ? {
            browserHostPid,
            browserHostFingerprint,
            browserHostCdpPort,
            browserHostMode: 'shared-profile' as const
          }
        : {})
    };
    try {
      this.profiles.markProvider(profile.id, target.provider);
      this.profiles.saveModelSettings(profile.id, target.provider, {
        ...(options.decisionMode !== undefined ? { decisionMode: options.decisionMode } : {}),
        ...(options.decisionModel !== undefined ? { decisionModel: options.decisionModel } : {}),
        ...(options.decisionUrl !== undefined ? { decisionUrl: options.decisionUrl } : {}),
        ...(options.decisionTimeoutMs !== undefined ? { decisionTimeoutMs: options.decisionTimeoutMs } : {}),
        ...(options.temporaryChat !== undefined ? { temporaryChat: options.temporaryChat } : {})
      });
      return this.instances.put(record);
    } catch (error) {
      terminateSpawnedOwned(child, serviceFingerprint);
      if (startedBrowserHost) terminateSpawnedOwned(browserHostChild, browserHostFingerprint);
      throw error;
    }
    });
  }

  async stop(id: string): Promise<boolean> {
    return await this.withControlLock(() => this.stopUnlocked(id));
  }

  private async stopUnlocked(id: string): Promise<boolean> {
    const instance = this.instances.get(id);
    if (!instance) return false;
    if (processMatches(instance.pid, instance.processFingerprint)) {
      terminateOwnedProcess(instance.pid, instance.processFingerprint, 'SIGTERM');
      await waitForExit(instance.pid, instance.processFingerprint, 360_000);
      if (processMatches(instance.pid, instance.processFingerprint)) {
        terminateOwnedProcess(instance.pid, instance.processFingerprint, 'SIGKILL');
      }
    }
    this.instances.remove(instance.id);
    if (instance.browserHostPid) {
      const stillUsed = this.instances.listActive().some(
        (candidate) => candidate.browserHostPid === instance.browserHostPid
      );
      if (!stillUsed) {
        terminateOwnedProcess(instance.browserHostPid, instance.browserHostFingerprint);
      }
    }
    return true;
  }

  async stopAll(): Promise<number> {
    return await this.withControlLock(async () => {
      const active = this.instances.listActive();
      const results = await Promise.allSettled(
        active.map((instance) => this.stopUnlocked(instance.id))
      );
      const stopped = results.reduce(
        (count, result) => count + (result.status === 'fulfilled' && result.value ? 1 : 0),
        0
      );
      this.reapOrphanBrowserHosts();
      return stopped;
    });
  }

  async configure(id: string, changes: ServiceModelOptions): Promise<ProxyInstanceRecord> {
    return await this.withControlLock(async () => {
      const current = this.instances.get(id);
      if (!current || !processMatches(current.pid, current.processFingerprint)) {
        throw new Error('Unknown or inactive reverse-proxy instance: ' + id);
      }
      // No data or process changes occur when validation fails.
      const next: StartServiceOptions = {
        target: current.target,
        id: current.id,
        profile: current.profileId,
        port: current.port,
        host: current.host,
        model: current.model,
        ...(current.logLevel !== undefined ? { logLevel: current.logLevel } : {}),
        ...(current.logContent !== undefined ? { logContent: current.logContent } : {}),
        ...(current.logFile ? { logFile: current.logFile } : {}),
        ...(current.ownerPid !== undefined ? { ownerPid: current.ownerPid } : {}),
        ...(current.decisionMode !== undefined ? { decisionMode: current.decisionMode } : {}),
        ...(current.decisionModel !== undefined ? { decisionModel: current.decisionModel } : {}),
        ...(current.decisionUrl !== undefined ? { decisionUrl: current.decisionUrl } : {}),
        ...(current.decisionTimeoutMs !== undefined ? { decisionTimeoutMs: current.decisionTimeoutMs } : {}),
        ...(current.temporaryChat !== undefined ? { temporaryChat: current.temporaryChat } : {}),
        ...changes
      };
      validateServiceModels(next);
      if (next.temporaryChat === 'required' && current.provider !== 'chatgpt') {
        throw new Error('Verified temporary chat is currently supported only for ChatGPT.');
      }
      await this.stopUnlocked(id);
      return await this.startUnlocked(next);
    });
  }

  async restart(id: string): Promise<ProxyInstanceRecord> {
    return await this.withControlLock(async () => {
      const instance = this.instances.get(id);
      if (!instance) throw new Error('Unknown reverse-proxy instance: ' + id);
      await this.stopUnlocked(instance.id);
      return await this.startUnlocked({
        target: instance.target,
        id: instance.id,
        profile: instance.profileId,
        port: instance.port,
        host: instance.host,
        ...(instance.decisionMode !== undefined ? { decisionMode: instance.decisionMode } : {}),
        ...(instance.decisionModel !== undefined ? { decisionModel: instance.decisionModel } : {}),
        ...(instance.decisionUrl !== undefined ? { decisionUrl: instance.decisionUrl } : {}),
        ...(instance.decisionTimeoutMs !== undefined ? { decisionTimeoutMs: instance.decisionTimeoutMs } : {}),
        ...(instance.temporaryChat !== undefined ? { temporaryChat: instance.temporaryChat } : {}),
        ...(instance.logLevel !== undefined ? { logLevel: instance.logLevel } : {}),
        ...(instance.logContent !== undefined ? { logContent: instance.logContent } : {}),
        ...(instance.logFile ? { logFile: instance.logFile } : {}),
        ...(instance.ownerPid !== undefined ? { ownerPid: instance.ownerPid } : {})
      });
    });
  }

  private async withProfileLock<T>(
    profileDirectory: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.profileLocks.get(profileDirectory) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent;
    });
    const tail = previous.then(() => current);
    this.profileLocks.set(profileDirectory, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.profileLocks.get(profileDirectory) === tail) {
        this.profileLocks.delete(profileDirectory);
      }
    }
  }

  private reapOrphanBrowserHosts(): void {
    const known = this.instances.list();
    const activeHostKeys = new Set(
      known
        .filter((instance) =>
          processMatches(instance.pid, instance.processFingerprint)
          && instance.browserHostPid
          && instance.browserHostFingerprint
          && processMatches(instance.browserHostPid, instance.browserHostFingerprint)
        )
        .map((instance) => String(instance.browserHostPid) + ':' + instance.browserHostFingerprint)
    );
    for (const instance of known) {
      if (!instance.browserHostPid || !instance.browserHostFingerprint) continue;
      const key = String(instance.browserHostPid) + ':' + instance.browserHostFingerprint;
      if (!activeHostKeys.has(key)) {
        terminateOwnedProcess(instance.browserHostPid, instance.browserHostFingerprint);
      }
    }
    this.instances.listActive();
  }

  private async allocateBrowserHostPort(
    active: readonly ProxyInstanceRecord[]
  ): Promise<number> {
    const used = new Set(
      active
        .map((instance) => instance.browserHostCdpPort)
        .filter((port): port is number => Number.isInteger(port))
    );
    for (let port = 39000; port <= 39099; port += 1) {
      if (used.has(port)) continue;
      if (await portAvailable('127.0.0.1', port)) return port;
    }
    throw new Error('No free browser-host CDP port found in range 39000-39099.');
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
    if (!processMatches(instance.pid, instance.processFingerprint)) return 'unhealthy';
    try {
      const response = await fetch('http://' + httpHost(instance.host) + ':' + instance.port + '/readyz', {
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) return 'ready';
      return 'unhealthy';
    } catch {
      return 'running';
    }
  }
}
