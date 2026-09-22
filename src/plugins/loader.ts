import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { providerRegistry, ProviderPluginRegistry } from './registry.js';
import { validateProviderPlugin, type ProviderPlugin } from './sdk.js';

interface ProviderPluginModule {
  default?: unknown;
  plugin?: unknown;
  providerPlugin?: unknown;
}

const loadedByRegistry = new WeakMap<ProviderPluginRegistry, Set<string>>();

function loadedSet(registry: ProviderPluginRegistry): Set<string> {
  let loaded = loadedByRegistry.get(registry);
  if (!loaded) {
    loaded = new Set<string>();
    loadedByRegistry.set(registry, loaded);
  }
  return loaded;
}

function resolvePluginModule(specifier: string, cwd: string): string {
  const normalized = specifier.trim();
  if (!normalized) throw new Error('Provider plugin module cannot be empty.');
  if (/^(?:https?|data|node):/i.test(normalized)) {
    throw new Error('Provider plugins must be local files or installed npm packages.');
  }
  if (normalized.startsWith('file:')) return normalized;
  if (isAbsolute(normalized) || normalized.startsWith('./') || normalized.startsWith('../')) {
    return pathToFileURL(resolve(cwd, normalized)).href;
  }
  const requireFromProject = createRequire(pathToFileURL(resolve(cwd, 'package.json')));
  return pathToFileURL(requireFromProject.resolve(normalized)).href;
}

function modulePlugin(module: ProviderPluginModule): ProviderPlugin {
  return validateProviderPlugin(module.default ?? module.providerPlugin ?? module.plugin);
}

export async function loadProviderPluginModules(
  specifiers: readonly string[],
  options: { cwd?: string; registry?: ProviderPluginRegistry } = {}
): Promise<ProviderPlugin[]> {
  const cwd = options.cwd ?? process.cwd();
  const registry = options.registry ?? providerRegistry;
  const loaded = loadedSet(registry);
  const result: ProviderPlugin[] = [];

  for (const specifier of specifiers) {
    const resolved = resolvePluginModule(specifier, cwd);
    if (loaded.has(resolved)) continue;
    const imported = await import(resolved) as ProviderPluginModule;
    const plugin = modulePlugin(imported);
    registry.register(plugin, resolved);
    loaded.add(resolved);
    result.push(plugin);
  }

  return result;
}
