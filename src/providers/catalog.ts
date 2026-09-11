import type { ProviderId, TransportMode } from '../types.js';

export interface UiProviderConfig {
  inputSelectors: string[];
  sendSelectors: string[];
  responseSelectors: string[];
  streamingSelectors: string[];
  newChatUrl?: string;
  uploadSelector?: string;
  supportsImageUpload: boolean;
}

export interface ProviderCapabilities {
  streaming: boolean;
  tools: 'protocol' | 'native-or-protocol';
  structuredOutput: 'best_effort' | 'native';
  systemMessages: 'native-or-emulated' | 'native';
  reasoning: boolean;
}

export interface ProviderModelDescriptor {
  id: string;
  aliases: readonly string[];
}

export interface ProviderPreset {
  id: Exclude<ProviderId, 'auto'>;
  name: string;
  hosts: string[];
  defaultApiModel: string;
  preferredTransport: Exclude<TransportMode, 'auto'>;
  transports: readonly Exclude<TransportMode, 'auto'>[];
  auth: 'browser-profile';
  capabilities: ProviderCapabilities;
  models: readonly ProviderModelDescriptor[];
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
  ],
  supportsImageUpload: false
};

const BASE_CAPABILITIES: ProviderCapabilities = Object.freeze({
  streaming: true,
  tools: 'native-or-protocol',
  structuredOutput: 'best_effort',
  systemMessages: 'native-or-emulated',
  reasoning: false
});

function model(id: string, aliases: readonly string[] = []): ProviderModelDescriptor {
  return Object.freeze({ id, aliases: Object.freeze([...aliases]) });
}

export const PROVIDERS: readonly ProviderPreset[] = Object.freeze([
  {
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
  },
  {
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
  },
  {
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
        'button[aria-label="Stop generation"]'
      ],
      newChatUrl: 'https://gemini.google.com/app',
      uploadSelector: 'input[type="file"]',
      supportsImageUpload: true
    }
  },
  {
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
  },
  {
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
  },
  {
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
] satisfies ProviderPreset[]);

function hostMatches(hostname: string, candidate: string): boolean {
  const host = hostname.toLowerCase();
  const expected = candidate.toLowerCase();
  return host === expected || host.endsWith(`.${expected}`);
}

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

export function providerModelIds(provider: ProviderPreset): string[] {
  return provider.models.map((item) => item.id);
}

export function providerModelAliases(provider: ProviderPreset): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const item of provider.models) {
    for (const alias of item.aliases) aliases[alias] = item.id;
  }
  return aliases;
}

export function detectProvider(targetUrl: string, requested: ProviderId = 'auto'): ProviderPreset {
  const hostname = new URL(targetUrl).hostname;
  if (requested !== 'auto') {
    const explicit = providerById(requested);
    if (!explicit) throw new Error(`Provider não suportado: ${requested}`);
    if (explicit.id !== 'generic' && !explicit.hosts.some((host) => hostMatches(hostname, host))) {
      throw new Error(`Provider ${explicit.id} não corresponde ao host ${hostname}. Para UIs customizadas/mirrors use --provider generic --transport ui.`);
    }
    return explicit;
  }
  return PROVIDERS.find((provider) => provider.id !== 'generic' && provider.hosts.some((host) => hostMatches(hostname, host)))
    ?? providerById('generic')!;
}

export function resolveTransport(requested: TransportMode, provider: ProviderPreset): 'network' | 'ui' {
  if (requested === 'auto') return provider.preferredTransport;
  if (!provider.transports.includes(requested)) {
    throw new Error(`Transport ${requested} não é suportado por ${provider.id}.`);
  }
  return requested;
}

export function transportCandidates(requested: TransportMode, provider: ProviderPreset): readonly ('network' | 'ui')[] {
  if (requested !== 'auto') return [resolveTransport(requested, provider)];
  const preferred = provider.preferredTransport;
  if (preferred === 'network' && provider.transports.includes('ui')) return ['network', 'ui'];
  return [preferred];
}

export function providerIds(): Exclude<ProviderId, 'auto'>[] {
  return PROVIDERS.map((provider) => provider.id);
}
