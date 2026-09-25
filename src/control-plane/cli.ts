import { loadProviderPluginModules } from '../plugins/loader.js';
import { providerRegistry } from '../plugins/registry.js';
import { ProfileRegistry } from './profile-registry.js';
import { ServiceManager } from './service-manager.js';

function flagValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function flagValues(args: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);
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
  const registry = new ProfileRegistry();
  registry.importLegacy(providerRegistry.ids());
  const action = args[0] || 'list';
  const json = args.includes('--json');
  if (action === 'list') {
    print({ schema_version: 1, profiles: registry.list() }, json);
    return 0;
  }
  if (action === 'create') {
    const name = args[1];
    if (!name) throw new Error('Usage: kitt-reverse-proxy profiles create <name> [--provider <id>] [--json]');
    const profile = registry.create(name, flagValues(args, '--provider'));
    print({ schema_version: 1, profile }, json);
    return 0;
  }
  if (action === 'remove') {
    const id = args[1];
    if (!id) throw new Error('Usage: kitt-reverse-proxy profiles remove <id> [--delete-data] [--json]');
    const removed = registry.remove(id, args.includes('--delete-data'));
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
    const instance = await manager.start({
      target,
      profile: flagValue(args, '--profile'),
      id: flagValue(args, '--id'),
      port: rawPort === undefined ? undefined : Number(rawPort),
      host: flagValue(args, '--host')
    });
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

export async function runControlPlaneCli(args: string[]): Promise<number | null> {
  const command = args[0];
  if (command === 'plugins') return await pluginsCommand(args.slice(1));
  if (command === 'profiles') return await profilesCommand(args.slice(1));
  if (command === 'service') return await serviceCommand(args.slice(1));
  return null;
}
