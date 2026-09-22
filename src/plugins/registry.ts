import { DEFAULT_PROVIDER_PLUGINS } from './default/index.js';
import {
  validateProviderPlugin,
  type ProviderPlugin,
  type ProviderPreset
} from './sdk.js';

export interface RegisteredProviderPlugin {
  readonly plugin: ProviderPlugin;
  readonly source: string;
}

function hostMatches(hostname: string, candidate: string): boolean {
  const host = hostname.toLowerCase();
  const expected = candidate.toLowerCase();
  return host === expected || host.endsWith(`.${expected}`);
}

export class ProviderPluginRegistry {
  private readonly recordsById = new Map<string, RegisteredProviderPlugin>();
  private readonly orderedProviders: ProviderPreset[] = [];

  constructor(initial: readonly ProviderPlugin[] = []) {
    for (const plugin of initial) this.register(plugin, 'default');
  }

  get providers(): readonly ProviderPreset[] {
    return this.orderedProviders;
  }

  get records(): readonly RegisteredProviderPlugin[] {
    return [...this.recordsById.values()];
  }

  register(candidate: unknown, source = 'external'): ProviderPlugin {
    const plugin = validateProviderPlugin(candidate);
    const id = plugin.provider.id;
    const existing = this.recordsById.get(id);
    if (existing) {
      throw new Error(`Provider plugin id already registered: ${id} (existing source: ${existing.source}).`);
    }
    this.recordsById.set(id, Object.freeze({ plugin, source }));
    this.orderedProviders.push(plugin.provider);
    return plugin;
  }

  get(id: string): ProviderPreset | undefined {
    return this.recordsById.get(id)?.plugin.provider;
  }

  ids(): string[] {
    return this.orderedProviders.map((provider) => provider.id);
  }

  detect(targetUrl: string, requested = 'auto'): ProviderPreset {
    const hostname = new URL(targetUrl).hostname;
    if (requested !== 'auto') {
      const explicit = this.get(requested);
      if (!explicit) throw new Error(`Provider não suportado: ${requested}`);
      if (explicit.id !== 'generic' && !explicit.hosts.some((host) => hostMatches(hostname, host))) {
        throw new Error(`Provider ${explicit.id} não corresponde ao host ${hostname}. Para UIs customizadas/mirrors use --provider generic --transport ui.`);
      }
      return explicit;
    }
    const detected = this.orderedProviders.find(
      (provider) => provider.id !== 'generic' && provider.hosts.some((host) => hostMatches(hostname, host))
    );
    if (detected) return detected;
    const generic = this.get('generic');
    if (!generic) throw new Error('Provider generic não registrado.');
    return generic;
  }
}

export const providerRegistry = new ProviderPluginRegistry(DEFAULT_PROVIDER_PLUGINS);
