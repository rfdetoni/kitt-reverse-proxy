import { defineProviderPlugin } from '../sdk.js';
import { BASE_CAPABILITIES, model } from './shared.js';

export const DEEPSEEK_PLUGIN = defineProviderPlugin({
  apiVersion: 1,
  version: '1.2.1',
  provider: {
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
    selectorVersion: 2,
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
    // Only read leaf answer text. Selecting an entire assistant wrapper can
    // accidentally include the DeepThink reasoning panel before the final reply.
    responseSelectors: [
      // DeepSeek distinguishes the answer leaf from the Thinking panel here.
      // Never fall back to generic '.ds-markdown': it can be model reasoning.
      '.ds-markdown.ds-assistant-message-main-content',
      '.ds-assistant-message-main-content',
      '[data-role="assistant"] .ds-assistant-message-main-content',
      '[data-testid*="assistant" i] .ds-assistant-message-main-content'
    ],
    // Provider reasoning panels are not assistant final answers. Only reject
    // nodes inside these regions, not later answer siblings.
    responseExcludeSelectors: [
      '[class*="thinking" i]',
      '[class*="reasoning" i]',
      '[class*="thought" i]',
      '[data-testid*="think" i]',
      '[data-testid*="reason" i]',
      '[data-role="reasoning"]',
      '[aria-label*="thinking" i]',
      '[aria-label*="thought" i]',
      'details[open]'
    ],
    // Paused generation is continued once by the host UI monitor, only from
    // the current assistant card; no login/authorization buttons are used.
    streamingSelectors: [
      '[data-is-streaming="true"]',
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Parar geração"]'
    ],
    newChatUrl: 'https://chat.deepseek.com/',
    supportsImageUpload: false
  }
  }
});
