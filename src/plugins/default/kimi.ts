import { defineProviderPlugin } from '../sdk.js';
import { BASE_CAPABILITIES, model } from './shared.js';

export const KIMI_PLUGIN = defineProviderPlugin({
  apiVersion: 1,
  version: '1.0.0',
  provider: {
  id: 'kimi',
  name: 'Kimi Web',
  hosts: ['kimi.com', 'www.kimi.com', 'kimi.moonshot.cn'],
  defaultApiModel: 'kimi-web',
  preferredTransport: 'ui',
  transports: ['ui', 'network'],
  auth: 'browser-profile',
  capabilities: BASE_CAPABILITIES,
  models: [model('kimi-web', ['kimi'])],
  ui: {
    selectorVersion: 1,
    inputSelectors: [
      '[contenteditable="true"][role="textbox"]',
      '.chat-input-editor[contenteditable="true"]',
      'textarea[placeholder*="ask" i]',
      'textarea[placeholder*="message" i]',
      '[contenteditable="true"]',
      'textarea'
    ],
    sendSelectors: [
      'button[aria-label*="send" i]',
      'button[aria-label*="enviar" i]',
      'button[data-testid*="send" i]',
      'button[type="submit"]'
    ],
    responseSelectors: [
      '[data-role="assistant"]',
      '[data-testid*="assistant" i]',
      '[class*="assistant-message" i]'
    ],
    streamingSelectors: [
      '[data-is-streaming="true"]',
      'button[data-testid="stop-button"]'
    ],
    newChatUrl: 'https://www.kimi.com/',
    supportsImageUpload: false
  }
  }
});
