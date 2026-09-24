import { defineProviderPlugin } from '../sdk.js';
import { BASE_CAPABILITIES, model } from './shared.js';

export const GEMINI_PLUGIN = defineProviderPlugin({
  apiVersion: 1,
  version: '1.0.0',
  provider: {
  id: 'gemini',
  name: 'Gemini Web',
  hosts: ['gemini.google.com'],
  defaultApiModel: 'gemini-web',
  preferredTransport: 'ui',
  transports: ['ui', 'network'],
  auth: 'browser-profile',
  capabilities: BASE_CAPABILITIES,
  models: [model('gemini-web', ['gemini', 'google-web'])],
  ui: {
    selectorVersion: 2,
    inputSelectors: [
      'rich-textarea .ql-editor[contenteditable="true"]',
      'rich-textarea [contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      '[contenteditable="true"][aria-label*="prompt" i]',
      '[role="textbox"][contenteditable="true"]'
    ],
    sendSelectors: [
      'button[aria-label="Send message"]',
      'button[aria-label="Enviar mensagem"]',
      'button[aria-label*="send" i]',
      'button[aria-label*="enviar" i]',
      'button.send-button',
      'button[type="submit"]'
    ],
    responseSelectors: [
      'model-response message-content',
      'model-response',
      '.model-response-text',
      'message-content .markdown',
      '.response-content',
      '[class*="model-response" i]'
    ],
    streamingSelectors: [
      '[data-is-streaming="true"]',
      '.streaming',
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop generation"]',
      'button[aria-label*="parar" i]',
      'button[aria-label*="interromper" i]'
    ],
    newChatUrl: 'https://gemini.google.com/app',
    manualAuthBrowser: 'system-chrome',
    manualAuthUrl: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fgemini.google.com%2Fapp',
    uploadSelector: 'input[type="file"]',
    supportsImageUpload: true
  }
  }
});
