import type { ProviderId, TransportMode } from '../types.js';
import { CHATGPT_PROVIDER } from './builtin/chatgpt.js';
import { CLAUDE_PROVIDER } from './builtin/claude.js';
import { DEEPSEEK_PROVIDER } from './builtin/deepseek.js';
import { GEMINI_PROVIDER } from './builtin/gemini.js';
import { GENERIC_PROVIDER } from './builtin/generic.js';
import { KIMI_PROVIDER } from './builtin/kimi.js';
import type { ProviderPreset } from './types.js';

export type {
  ProviderCapabilities,
  ProviderModelDescriptor,
  ProviderPreset,
  UiProviderConfig
} from './types.js';

export const PROVIDERS: readonly ProviderPreset[] = Object.freeze([
  CHATGPT_PROVIDER,
  CLAUDE_PROVIDER,
  GEMINI_PROVIDER,
  KIMI_PROVIDER,
  DEEPSEEK_PROVIDER,
  GENERIC_PROVIDER
]);

function hostMatches(hostname: string, candidate: string): boolean {
  const host = hostname.toLowerCase();
  const expected = candidate.toLowerCase();
  return host === expected || host.endsWith(`.${expected}`);
}

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
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
  const hostname = new URL(targetUrl).hostname;
  if (requested !== 'auto') {
    const explicit = providerById(requested);
    if (!explicit) throw new Error(`Provider não suportado: ${requested}`);
    if (explicit.id !== 'generic' && !explicit.hosts.some((host) => hostMatches(hostname, host))) {
      throw new Error(`Provider ${explicit.id} não corresponde ao host ${hostname}. Para UIs customizadas/mirrors use --provider generic --transport ui.`);
    }
    return explicit;
  }
  return PROVIDERS.find((provider) => provider.id !== 'generic' && provider.hosts.some((host) => hostMatches(hostname, host)))
    ?? providerById('generic')!;
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

export function providerIds(): Exclude<ProviderId, 'auto'>[] {
  return PROVIDERS.map((provider) => provider.id);
}
