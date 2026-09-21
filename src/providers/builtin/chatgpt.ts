import type { ProviderPreset } from '../types.js';
import { BASE_CAPABILITIES, model } from '../shared.js';

export const CHATGPT_PROVIDER = Object.freeze({
  id: 'chatgpt',
  name: 'ChatGPT Web',
  hosts: ['chatgpt.com', 'chat.openai.com'],
  defaultApiModel: 'chatgpt-web',
  preferredTransport: 'ui',
  transports: ['ui', 'network'],
  auth: 'browser-profile',
  capabilities: { ...BASE_CAPABILITIES, reasoning: true },
  models: [model('chatgpt-web', ['chatgpt', 'openai-web'])],
  ui: {
    selectorVersion: 2,
    inputSelectors: [
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    sendSelectors: [
      'button[data-testid="send-button"]:not([data-testid="stop-button"])',
      '#composer-submit-button:not([data-testid="stop-button"]):not([aria-label*="stop" i]):not([aria-label*="parar" i]):not([aria-label*="interromper" i])',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Enviar prompt"]',
      'button[aria-label*="send" i]:not([aria-label*="stop" i])',
      'button[aria-label*="enviar" i]:not([aria-label*="parar" i])',
      'form button[type="submit"]:not([data-testid="stop-button"])'
    ],
    responseSelectors: [
      '[data-message-author-role="assistant"] .markdown',
      '.agent-turn .markdown',
      'article [data-message-author-role="assistant"] .markdown',
      '[data-message-id] .markdown',
      '[data-message-author-role="assistant"]',
      '[data-testid^="conversation-turn"] [data-message-author-role="assistant"]',
      '[class*="assistant-message" i]',
      '.markdown'
    ],
    streamingSelectors: [
      'button[data-testid="stop-button"]',
      '#composer-submit-button[data-testid="stop-button"]',
      '#composer-submit-button[aria-label="Stop generating"]',
      '#composer-submit-button[aria-label="Parar de gerar"]',
      '#composer-submit-button[aria-label="Interromper geração"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Parar de gerar"]',
      'button[aria-label="Interromper geração"]',
      '[data-is-streaming="true"]'
    ],
    newChatUrl: 'https://chatgpt.com/',
    uploadSelector: 'input[type="file"][accept*="image"], input[type="file"]',
    supportsImageUpload: true
  }
} satisfies ProviderPreset);
