import type { ProviderId, TransportMode } from '../types.js';

export interface UiProviderConfig {
  inputSelectors: string[];
  sendSelectors: string[];
  responseSelectors: string[];
  streamingSelectors: string[];
  newChatUrl?: string;
}

export interface ProviderPreset {
  id: Exclude<ProviderId, 'auto'>;
  name: string;
  hosts: string[];
  defaultApiModel: string;
  preferredTransport: Exclude<TransportMode, 'auto'>;
  ui: UiProviderConfig;
}

const GENERIC_UI: UiProviderConfig = {
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
  ]
};

export const PROVIDERS: readonly ProviderPreset[] = Object.freeze([
  {
    id: 'chatgpt',
    name: 'ChatGPT Web',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    defaultApiModel: 'chatgpt-web',
    preferredTransport: 'ui',
    ui: {
      inputSelectors: [
        '#prompt-textarea',
        '[data-testid="prompt-textarea"]',
        '[contenteditable="true"][data-lexical-editor="true"]',
        '[contenteditable="true"][role="textbox"]'
      ],
      sendSelectors: [
        '#composer-submit-button',
        'button[data-testid="send-button"]',
        'button[aria-label*="send" i]',
        'form button[type="submit"]'
      ],
      responseSelectors: [
        '[data-message-author-role="assistant"]',
        '[data-testid^="conversation-turn"] [data-message-author-role="assistant"]'
      ],
      streamingSelectors: [
        'button[data-testid="stop-button"]',
        'button[aria-label*="stop" i]'
      ],
      newChatUrl: 'https://chatgpt.com/'
    }
  },
  {
    id: 'claude',
    name: 'Claude Web',
    hosts: ['claude.ai'],
    defaultApiModel: 'claude-web',
    preferredTransport: 'ui',
    ui: {
      inputSelectors: [
        '.ProseMirror[contenteditable="true"]',
        '.tiptap[contenteditable="true"]',
        '[aria-label*="message" i][contenteditable="true"]',
        'div[role="textbox"][contenteditable="true"]',
        'div[contenteditable="true"]'
      ],
      sendSelectors: [
        'button[data-testid="send-button"]',
        'button[aria-label*="send message" i]',
        'button[aria-label="Send"]',
        'button[type="submit"]'
      ],
      responseSelectors: [
        '[data-testid="assistant-message"]',
        '[data-testid*="assistant" i]',
        '.font-claude-message',
        '.font-claude-response-body'
      ],
      streamingSelectors: [
        '[data-is-streaming="true"]',
        'button[data-testid="stop-button"]',
        'button[aria-label*="stop" i]'
      ],
      newChatUrl: 'https://claude.ai/new'
    }
  },
  {
    id: 'gemini',
    name: 'Gemini Web',
    hosts: ['gemini.google.com'],
    defaultApiModel: 'gemini-web',
    preferredTransport: 'ui',
    ui: {
      inputSelectors: [
        'rich-textarea .ql-editor[contenteditable="true"]',
        'rich-textarea [contenteditable="true"]',
        '.ql-editor[contenteditable="true"]',
        '[contenteditable="true"][aria-label*="prompt" i]',
        '[role="textbox"][contenteditable="true"]'
      ],
      sendSelectors: [
        'button[aria-label="Send message"]',
        'button[aria-label*="send" i]',
        'button.send-button',
        'button[type="submit"]'
      ],
      responseSelectors: [
        'model-response message-content',
        'model-response',
        '.model-response-text',
        'message-content .markdown',
        '.response-content'
      ],
      streamingSelectors: [
        '[data-is-streaming="true"]',
        '.streaming',
        'button[aria-label*="stop" i]'
      ],
      newChatUrl: 'https://gemini.google.com/app'
    }
  },
  {
    id: 'kimi',
    name: 'Kimi Web',
    hosts: ['kimi.com', 'www.kimi.com', 'kimi.moonshot.cn'],
    defaultApiModel: 'kimi-web',
    preferredTransport: 'ui',
    ui: {
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
        'button[aria-label*="stop" i]',
        'button[data-testid*="stop" i]'
      ],
      newChatUrl: 'https://www.kimi.com/'
    }
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Web',
    hosts: ['chat.deepseek.com', 'deepseek.com'],
    defaultApiModel: 'deepseek-web',
    preferredTransport: 'ui',
    ui: {
      inputSelectors: [
        'textarea[placeholder*="message" i]',
        'textarea',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]'
      ],
      sendSelectors: [
        'button[aria-label*="send" i]',
        'button[data-testid*="send" i]',
        'button[type="submit"]'
      ],
      responseSelectors: [
        '[data-role="assistant"]',
        '[data-testid*="assistant" i]',
        '[class*="assistant" i] .ds-markdown',
        '[class*="assistant" i] [class*="markdown" i]'
      ],
      streamingSelectors: [
        '[data-is-streaming="true"]',
        'button[aria-label*="stop" i]',
        'button[data-testid*="stop" i]'
      ],
      newChatUrl: 'https://chat.deepseek.com/'
    }
  },
  {
    id: 'generic',
    name: 'Generic Web Chat',
    hosts: [],
    defaultApiModel: 'adaptive-web-chat',
    preferredTransport: 'network',
    ui: GENERIC_UI
  }
] satisfies ProviderPreset[]);

function hostMatches(hostname: string, candidate: string): boolean {
  const host = hostname.toLowerCase();
  const expected = candidate.toLowerCase();
  return host === expected || host.endsWith(`.${expected}`);
}

export function detectProvider(targetUrl: string, requested: ProviderId = 'auto'): ProviderPreset {
  if (requested !== 'auto') {
    const explicit = PROVIDERS.find((provider) => provider.id === requested);
    if (!explicit) throw new Error(`Provider não suportado: ${requested}`);
    return explicit;
  }
  const hostname = new URL(targetUrl).hostname;
  return PROVIDERS.find((provider) => provider.id !== 'generic' && provider.hosts.some((host) => hostMatches(hostname, host)))
    ?? PROVIDERS.find((provider) => provider.id === 'generic')!;
}

export function resolveTransport(requested: TransportMode, provider: ProviderPreset): 'network' | 'ui' {
  return requested === 'auto' ? provider.preferredTransport : requested;
}

export function providerIds(): Exclude<ProviderId, 'auto'>[] {
  return PROVIDERS.map((provider) => provider.id);
}
