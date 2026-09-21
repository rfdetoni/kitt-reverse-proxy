import type { ProviderPreset } from '../types.js';
import { BASE_CAPABILITIES, model } from '../shared.js';

export const CLAUDE_PROVIDER = Object.freeze({
  id: 'claude',
  name: 'Claude Web',
  hosts: ['claude.ai'],
  defaultApiModel: 'claude-web',
  preferredTransport: 'ui',
  transports: ['ui', 'network'],
  auth: 'browser-profile',
  capabilities: BASE_CAPABILITIES,
  models: [model('claude-web', ['claude', 'anthropic-web'])],
  ui: {
    selectorVersion: 2,
    inputSelectors: [
      '.ProseMirror[contenteditable="true"]',
      '.tiptap[contenteditable="true"]',
      '[aria-label*="message" i][contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"]'
    ],
    sendSelectors: [
      'button[data-testid="send-button"]',
      'button[aria-label*="send" i]',
      'button[aria-label*="enviar" i]',
      'button[aria-label="Send"]',
      'button[type="submit"]'
    ],
    responseSelectors: [
      '[data-testid="assistant-message"]',
      '[data-testid*="assistant" i]',
      '.font-claude-message',
      '.font-claude-response-body',
      '.standard-markdown',
      '[class*="assistant" i]'
    ],
    streamingSelectors: [
      '[data-is-streaming="true"]',
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop Response"]',
      'button[aria-label="Stop generating"]'
    ],
    newChatUrl: 'https://claude.ai/new',
    uploadSelector: 'input[type="file"][accept*="image"], input[type="file"]',
    supportsImageUpload: true
  }
} satisfies ProviderPreset);
