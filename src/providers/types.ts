import type { ProviderId, TransportMode } from '../types.js';

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
  id: Exclude<ProviderId, 'auto'>;
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
