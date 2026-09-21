import type { ProviderPreset } from '../types.js';
import { BASE_CAPABILITIES, GENERIC_UI, model } from '../shared.js';

export const GENERIC_PROVIDER: ProviderPreset = Object.freeze({
  id: 'generic',
  name: 'Generic Web Chat',
  hosts: [],
  defaultApiModel: 'adaptive-web-chat',
  preferredTransport: 'network',
  transports: ['network', 'ui'],
  auth: 'browser-profile',
  capabilities: BASE_CAPABILITIES,
  models: [model('adaptive-web-chat', ['generic-web-chat'])],
  ui: GENERIC_UI
});
