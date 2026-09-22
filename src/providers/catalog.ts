import type { ProviderId, TransportMode } from '../types.js';
import { providerRegistry } from '../plugins/registry.js';
import type { ProviderPreset } from '../plugins/sdk.js';

export type {
  ProviderCapabilities,
  ProviderModelDescriptor,
  ProviderPlugin,
  ProviderPreset,
  UiProviderConfig
} from '../plugins/sdk.js';

export { PROVIDER_PLUGIN_API_VERSION, defineProviderPlugin, validateProviderPlugin } from '../plugins/sdk.js';
export { ProviderPluginRegistry, providerRegistry } from '../plugins/registry.js';

export const PROVIDERS: readonly ProviderPreset[] = providerRegistry.providers;

export function providerById(id: string): ProviderPreset | undefined {
  return providerRegistry.get(id);
}

export function providerModelIds(provider: ProviderPreset): string[] {
  return provider.models.map((item) => item.id);
}

export function providerModelAliases(provider: ProviderPreset): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const item of provider.models) {
    for (const alias of item.aliases) aliases[alias] = item.id;
  }
  return aliases;
}

export function detectProvider(targetUrl: string, requested: ProviderId = 'auto'): ProviderPreset {
  return providerRegistry.detect(targetUrl, requested);
}

export function resolveTransport(requested: TransportMode, provider: ProviderPreset): 'network' | 'ui' {
  if (requested === 'auto') return provider.preferredTransport;
  if (!provider.transports.includes(requested)) {
    throw new Error(`Transport ${requested} não é suportado por ${provider.id}.`);
  }
  return requested;
}

export function transportCandidates(requested: TransportMode, provider: ProviderPreset): readonly ('network' | 'ui')[] {
  if (requested !== 'auto') return [resolveTransport(requested, provider)];
  const preferred = provider.preferredTransport;
  if (preferred === 'network' && provider.transports.includes('ui')) return ['network', 'ui'];
  return [preferred];
}

export function providerIds(): string[] {
  return providerRegistry.ids();
}
