import type { ProviderCapabilities, ProviderModelDescriptor, UiProviderConfig } from '../sdk.js';

export const GENERIC_UI: UiProviderConfig = {
  selectorVersion: 1,
  inputSelectors: [
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="ask" i]',
    'textarea[placeholder*="prompt" i]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'textarea'
  ],
  sendSelectors: [
    'button[type="submit"]',
    'button[aria-label*="send" i]',
    'button[data-testid*="send" i]'
  ],
  responseSelectors: [
    '[data-message-author-role="assistant"]',
    '[data-role="assistant"]',
    '[data-testid*="assistant" i]',
    '[class*="assistant-message" i]'
  ],
  streamingSelectors: [
    'button[aria-label*="stop" i]',
    'button[data-testid*="stop" i]',
    '[data-is-streaming="true"]'
  ],
  supportsImageUpload: false
};

export const BASE_CAPABILITIES: ProviderCapabilities = Object.freeze({
  streaming: true,
  tools: 'native-or-protocol',
  structuredOutput: 'best_effort',
  systemMessages: 'native-or-emulated',
  reasoning: false
});

export function model(id: string, aliases: readonly string[] = []): ProviderModelDescriptor {
  return Object.freeze({ id, aliases: Object.freeze([...aliases]) });
}
