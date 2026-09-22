import { defineProviderPlugin } from '../sdk.js';
import { BASE_CAPABILITIES, GENERIC_UI, model } from './shared.js';

export const GENERIC_PLUGIN = defineProviderPlugin({
  apiVersion: 1,
  version: '1.0.0',
  provider: {
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
  }
});
