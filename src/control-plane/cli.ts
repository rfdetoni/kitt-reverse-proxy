import { loadProviderPluginModules } from '../plugins/loader.js';
import { providerRegistry } from '../plugins/registry.js';
import { ServiceManager } from './service-manager.js';
import {
  controlServerReady,
  ensureControlServer,
  startControlServer,
  stopControlServer
} from './server.js';

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function flagValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const candidate = args[index + 1];
    if (args[index] === name && candidate) values.push(candidate);
  }
  return values;
}

function print(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function ensureConfiguredPlugins(args: readonly string[]): Promise<void> {
  const configured = [
    ...(process.env.PROXY_PROVIDER_PLUGINS || '').split(',').map((item) => item.trim()).filter(Boolean),
    ...flagValues(args, '--provider-plugin')
  ];
  if (configured.length) await loadProviderPluginModules([...new Set(configured)]);
}

async function pluginsCommand(args: string[]): Promise<number> {
  if ((args[0] || 'list') !== 'list') throw new Error('Usage: kitt-reverse-proxy plugins list [--json]');
  await ensureConfiguredPlugins(args);
  const records = providerRegistry.records.map(({ plugin, source }) => ({
    id: plugin.provider.id,
    name: plugin.provider.name,
    version: plugin.version,
    source,
    default_url: plugin.provider.ui.newChatUrl ?? null,
    default_model: plugin.provider.defaultApiModel,
    transports: [...plugin.provider.transports],
    auth: plugin.provider.auth
  }));
  print({ schema_version: 1, plugins: records }, args.includes('--json'));
  return 0;
}

async function profilesCommand(args: string[]): Promise<number> {
  const manager = new ServiceManager();
  const registry = manager.profiles;
  await manager.withControlLock(() => registry.importLegacy(providerRegistry.ids()));
  const action = args[0] || 'list';
  const json = args.includes('--json');
  if (action === 'list') {
    print({ schema_version: 1, profiles: registry.list() }, json);
    return 0;
  }
  if (action === 'create') {
    const name = args[1];
    if (!name) throw new Error('Usage: kitt-reverse-proxy profiles create <name> [--provider <id>] [--json]');
    const profile = await manager.withControlLock(
      () => registry.create(name, flagValues(args, '--provider'))
    );
    print({ schema_version: 1, profile }, json);
    return 0;
  }
  if (action === 'remove') {
    const id = args[1];
    if (!id) throw new Error('Usage: kitt-reverse-proxy profiles remove <id> [--delete-data] [--json]');
    const removed = await manager.withControlLock(() => {
      const inUse = manager.instances.listActive().some((instance) => instance.profileId === id);
      if (inUse) throw new Error('Cannot remove a browser profile used by a running service: ' + id);
      return registry.remove(id, args.includes('--delete-data'));
    });
    print({ schema_version: 1, id, removed }, json);
    return removed ? 0 : 1;
  }
  throw new Error('Usage: kitt-reverse-proxy profiles <list|create|remove>');
}

async function serviceCommand(args: string[]): Promise<number> {
  const manager = new ServiceManager();
  const action = args[0] || 'list';
  const json = args.includes('--json');
  if (action === 'list') {
    print({ schema_version: 1, instances: await manager.list() }, json);
    return 0;
  }
  if (action === 'start') {
    const target = args[1];
    if (!target) {
      throw new Error('Usage: kitt-reverse-proxy service start <provider|url> [--profile <id>] [--id <id>] [--port <n>]');
    }
    const rawPort = flagValue(args, '--port');
    const rawLogLevel = flagValue(args, '--log-level');
    const rawOwnerPid = flagValue(args, '--owner-pid');
    const rawLogContent = flagValue(args, '--log-content');
    const options: {
      target: string;
      profile?: string;
      id?: string;
      port?: number;
      host?: string;
      logLevel?: 0 | 1 | 2;
      logContent?: 'none' | 'metadata' | 'full';
      logFile?: string;
      ownerPid?: number;
    } = { target };
    const profile = flagValue(args, '--profile');
    const id = flagValue(args, '--id');
    const host = flagValue(args, '--host');
    const logFile = flagValue(args, '--log-file');
    if (profile) options.profile = profile;
    if (id) options.id = id;
    if (host) options.host = host;
    if (rawPort !== undefined) options.port = Number(rawPort);
    if (rawLogLevel !== undefined) {
      const level = Number(rawLogLevel);
      if (!Number.isInteger(level) || level < 0 || level > 2) {
        throw new Error('--log-level must be 0, 1 or 2.');
      }
      options.logLevel = level as 0 | 1 | 2;
    }
    if (rawLogContent !== undefined) {
      if (!['none', 'metadata', 'full'].includes(rawLogContent)) {
        throw new Error('--log-content must be none, metadata or full.');
      }
      options.logContent = rawLogContent as 'none' | 'metadata' | 'full';
    }
    if (logFile) options.logFile = logFile;
    if (rawOwnerPid !== undefined) {
      const ownerPid = Number(rawOwnerPid);
      if (!Number.isInteger(ownerPid) || ownerPid < 1) {
        throw new Error('--owner-pid must be a positive integer.');
      }
      options.ownerPid = ownerPid;
    }
    const instance = await manager.start(options);
    print({ schema_version: 1, instance }, json);
    return 0;
  }
  if (action === 'stop') {
    if (args.includes('--all')) {
      const stopped = await manager.stopAll();
      print({ schema_version: 1, stopped }, json);
      return 0;
    }
    const id = args[1];
    if (!id) throw new Error('Usage: kitt-reverse-proxy service stop <id>|--all');
    const stopped = await manager.stop(id);
    print({ schema_version: 1, id, stopped }, json);
    return stopped ? 0 : 1;
  }
  if (action === 'restart') {
    const id = args[1];
    if (!id) throw new Error('Usage: kitt-reverse-proxy service restart <id>');
    const instance = await manager.restart(id);
    print({ schema_version: 1, instance }, json);
    return 0;
  }
  throw new Error('Usage: kitt-reverse-proxy service <list|start|stop|restart>');
}


async function controlCommand(args: string[]): Promise<number> {
  const action = args[0] || 'status';
  const json = args.includes('--json');
  if (action === 'status') {
    const ready = await controlServerReady();
    print({ schema_version: 1, ready }, json);
    return ready ? 0 : 1;
  }
  if (action === 'ensure') {
    const result = await ensureControlServer();
    print({ schema_version: 1, ...result }, json);
    return result.ready ? 0 : 1;
  }
  if (action === 'serve') {
    const server = await startControlServer();
    const close = (): void => {
      server.close();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    print({ schema_version: 1, ready: true, pid: process.pid }, json);
    return 0;
  }
  if (action === 'stop') {
    const stopped = await stopControlServer();
    print({ schema_version: 1, stopped }, json);
    return stopped ? 0 : 1;
  }
  throw new Error('Usage: kitt-reverse-proxy control <status|ensure|serve|stop> [--json]');
}

export async function runControlPlaneCli(args: string[]): Promise<number | null> {
  const command = args[0];
  if (command === 'control') return await controlCommand(args.slice(1));
  if (command === 'plugins') return await pluginsCommand(args.slice(1));
  if (command === 'profiles') return await profilesCommand(args.slice(1));
  if (command === 'service') return await serviceCommand(args.slice(1));
  return null;
}
