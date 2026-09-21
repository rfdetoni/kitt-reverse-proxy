import type { ProviderPreset } from '../types.js';
import { BASE_CAPABILITIES, model } from '../shared.js';

export const DEEPSEEK_PROVIDER = Object.freeze({
  id: 'deepseek',
  name: 'DeepSeek Web',
  hosts: ['chat.deepseek.com', 'deepseek.com'],
  defaultApiModel: 'deepseek-web',
  preferredTransport: 'ui',
  transports: ['ui', 'network'],
  auth: 'browser-profile',
  capabilities: BASE_CAPABILITIES,
  models: [model('deepseek-web', ['deepseek'])],
  ui: {
    selectorVersion: 1,
    inputSelectors: [
      'textarea[placeholder*="message" i]',
      'textarea',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]'
    ],
    sendSelectors: [
      'button[aria-label*="send" i]',
      'button[aria-label*="enviar" i]',
      'button[data-testid*="send" i]',
      'div[role="button"][aria-label*="send" i]',
      'button[type="submit"]'
    ],
    responseSelectors: [
      '[data-role="assistant"]',
      '[data-testid*="assistant" i]',
      '[class*="assistant" i] .ds-markdown',
      '[class*="assistant" i] [class*="markdown" i]',
      '.ds-markdown'
    ],
    streamingSelectors: [
      '[data-is-streaming="true"]',
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Parar geração"]'
    ],
    newChatUrl: 'https://chat.deepseek.com/',
    supportsImageUpload: false
  }
} satisfies ProviderPreset);
