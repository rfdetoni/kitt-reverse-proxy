import type { TransportMode } from '../types.js';

export const PROVIDER_PLUGIN_API_VERSION = 1 as const;

export interface UiProviderConfig {
  selectorVersion: number;
  inputSelectors: string[];
  sendSelectors: string[];
  responseSelectors: string[];
  streamingSelectors: string[];
  newChatUrl?: string;
  uploadSelector?: string;
  supportsImageUpload: boolean;
}

export interface ProviderCapabilities {
  streaming: boolean;
  tools: 'protocol' | 'native-or-protocol';
  structuredOutput: 'best_effort' | 'native';
  systemMessages: 'native-or-emulated' | 'native';
  reasoning: boolean;
}

export interface ProviderModelDescriptor {
  id: string;
  aliases: readonly string[];
}

export interface ProviderPreset {
  id: string;
  name: string;
  hosts: string[];
  defaultApiModel: string;
  preferredTransport: Exclude<TransportMode, 'auto'>;
  transports: readonly Exclude<TransportMode, 'auto'>[];
  auth: 'browser-profile';
  capabilities: ProviderCapabilities;
  models: readonly ProviderModelDescriptor[];
  ui: UiProviderConfig;
}

export interface ProviderPlugin {
  apiVersion: typeof PROVIDER_PLUGIN_API_VERSION;
  version: string;
  provider: ProviderPreset;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function assertStringArray(value: unknown, field: string, allowEmpty = true): asserts value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`Provider plugin field ${field} must be ${allowEmpty ? 'an' : 'a non-empty'} array of strings.`);
  }
}

export function validateProviderPlugin(value: unknown): ProviderPlugin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Provider plugin must be an object.');
  }
  const plugin = value as Partial<ProviderPlugin>;
  if (plugin.apiVersion !== PROVIDER_PLUGIN_API_VERSION) {
    throw new TypeError(`Unsupported provider plugin API version: ${String(plugin.apiVersion)}.`);
  }
  if (typeof plugin.version !== 'string' || !SEMVER.test(plugin.version)) {
    throw new TypeError('Provider plugin version must be semantic versioning (MAJOR.MINOR.PATCH).');
  }
  if (!plugin.provider || typeof plugin.provider !== 'object') {
    throw new TypeError('Provider plugin must declare provider metadata.');
  }

  const provider = plugin.provider as ProviderPreset;
  if (!PROVIDER_ID.test(provider.id) || provider.id === 'auto') {
    throw new TypeError(`Invalid provider plugin id: ${String(provider.id)}.`);
  }
  if (typeof provider.name !== 'string' || !provider.name.trim()) throw new TypeError('Provider plugin name is required.');
  assertStringArray(provider.hosts, 'provider.hosts');
  if (typeof provider.defaultApiModel !== 'string' || !provider.defaultApiModel.trim()) {
    throw new TypeError('Provider plugin defaultApiModel is required.');
  }
  if (!Array.isArray(provider.transports) || provider.transports.length === 0 || provider.transports.some((item) => item !== 'ui' && item !== 'network')) {
    throw new TypeError('Provider plugin transports must contain ui and/or network.');
  }
  if (!provider.transports.includes(provider.preferredTransport)) {
    throw new TypeError('Provider plugin preferredTransport must be included in transports.');
  }
  if (provider.auth !== 'browser-profile') throw new TypeError('Provider plugin auth must be browser-profile.');
  if (!provider.capabilities || typeof provider.capabilities !== 'object') throw new TypeError('Provider plugin capabilities are required.');
  if (!Array.isArray(provider.models) || provider.models.length === 0) throw new TypeError('Provider plugin must expose at least one model.');
  for (const model of provider.models) {
    if (!model || typeof model.id !== 'string' || !model.id.trim()) throw new TypeError('Provider model id is required.');
    if (!Array.isArray(model.aliases) || model.aliases.some((alias: unknown) => typeof alias !== 'string')) {
      throw new TypeError(`Provider model aliases must be strings: ${model.id}.`);
    }
  }
  if (!provider.ui || typeof provider.ui !== 'object') throw new TypeError('Provider plugin UI metadata is required.');
  if (!Number.isInteger(provider.ui.selectorVersion) || provider.ui.selectorVersion < 1) {
    throw new TypeError('Provider plugin ui.selectorVersion must be a positive integer.');
  }
  assertStringArray(provider.ui.inputSelectors, 'provider.ui.inputSelectors', false);
  assertStringArray(provider.ui.sendSelectors, 'provider.ui.sendSelectors', false);
  assertStringArray(provider.ui.responseSelectors, 'provider.ui.responseSelectors', false);
  assertStringArray(provider.ui.streamingSelectors, 'provider.ui.streamingSelectors');
  if (typeof provider.ui.supportsImageUpload !== 'boolean') {
    throw new TypeError('Provider plugin ui.supportsImageUpload must be boolean.');
  }

  return value as ProviderPlugin;
}

export function defineProviderPlugin(plugin: ProviderPlugin): ProviderPlugin {
  const validated = validateProviderPlugin(plugin);
  return Object.freeze({
    ...validated,
    provider: Object.freeze({ ...validated.provider })
  });
}
