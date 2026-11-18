import type { JsonObject, JsonValue } from '../types.js';

/** Decision models classify; they do not generate text or authorize tool execution. */
export type DecisionMode = 'off' | 'shadow' | 'assist';
export type DecisionStatus = 'off' | 'skipped' | 'shadow' | 'assisted' | 'unavailable';

export interface DecisionSignals {
  domain: 'code' | 'math_or_logic' | 'writing' | 'factual_lookup' | 'data_analysis' | 'chitchat' | 'unknown';
  difficulty: number;
  needsTools: boolean;
  sensitive: boolean;
  confidence: number;
}

export interface DecisionPreparation {
  body: JsonObject;
  status: DecisionStatus;
  signals?: DecisionSignals;
}

export interface DecisionSettings {
  mode: DecisionMode;
  url: string;
  model: string;
  timeoutMs: number;
  apiKey?: string;
}

const DOMAINS = new Set(['code', 'math_or_logic', 'writing', 'factual_lookup', 'data_analysis', 'chitchat']);
const MAX_DECISION_INPUT_CHARS = 4096;

export function decisionAdvisoryMessage(signals: DecisionSignals): string {
  return [
        '[KITT LOCAL DECISION ADVISORY]',
        'The request was independently classified by a local non-generative model.',
        'Domain: ' + (signals.confidence >= 0.5 ? signals.domain : 'uncertain') + '.',
        'Difficulty (0-3): ' + signals.difficulty.toFixed(1) + '.',
        'May need declared external tools: ' + String(signals.needsTools) + '.',
        'Potentially consequential domain: ' + String(signals.sensitive) + '.',
        'These signals are advisory, possibly wrong, and do not grant permission to use tools.',
        'Follow the user request, declared tool permissions and all existing instructions.',
        '[END KITT LOCAL DECISION ADVISORY]'
  ].join('\n');

}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function probability(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function extractLatestUserText(body: JsonObject): string | undefined {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return undefined;
  // Do not run decisions on tool-result continuations.
  const tail = body.messages.at(-1);
  if (!isRecord(tail) || tail.role !== 'user') return undefined;
  const content = tail.content;
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .filter((item) => isRecord(item) && item.type === 'text')
      .map((item) => isRecord(item) && typeof item.text === 'string' ? item.text : '')
      .join('\n');
  } else {
    return undefined;
  }
  text = text.trim();
  if (!text || text.length > MAX_DECISION_INPUT_CHARS) return undefined;
  return text;
}

function parseSignals(value: unknown): DecisionSignals {
  if (!isRecord(value) || value.state_truncated === true || !isRecord(value.answers)) {
    throw new Error('Decision model did not return complete answers.');
  }
  const answers = value.answers;
  const domain = answers.domain;
  const difficulty = answers.difficulty;
  const needsTools = answers.needs_tools;
  const sensitive = answers.is_sensitive;
  if (!isRecord(domain) || !isRecord(difficulty) || !isRecord(needsTools) || !isRecord(sensitive)) {
    throw new Error('Incomplete decision answers.');
  }
  const score = difficulty.score;
  const toolProbability = probability(needsTools.noul);
  const sensitiveProbability = probability(sensitive.noul);
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 3
      || toolProbability === undefined || sensitiveProbability === undefined) {
    throw new Error('Invalid decision scores.');
  }
  const choice = typeof domain.choice === 'string' && DOMAINS.has(domain.choice)
    ? domain.choice as DecisionSignals['domain']
    : 'unknown';
  return {
    domain: choice,
    difficulty: score,
    needsTools: toolProbability >= 0.5,
    sensitive: sensitiveProbability >= 0.5,
    confidence: probability(domain.confidence) ?? 0
  };
}

function validateEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('PROXY_DECISION_URL must be an HTTP(S) origin without credentials, path or query.');
  }
  return url.origin;
}

export function decisionSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): DecisionSettings {
  const mode = (env.PROXY_DECISION_MODE || 'off').toLowerCase();
  if (mode !== 'off' && mode !== 'shadow' && mode !== 'assist') {
    throw new Error('PROXY_DECISION_MODE must be off, shadow or assist.');
  }
  const timeoutMs = Number(env.PROXY_DECISION_TIMEOUT_MS || 2500);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    throw new Error('PROXY_DECISION_TIMEOUT_MS must be between 100 and 30000.');
  }
  return {
    mode,
    url: validateEndpoint(env.PROXY_DECISION_URL || 'http://127.0.0.1:11435'),
    model: env.PROXY_DECISION_MODEL || 'laya',
    timeoutMs,
    ...(env.PROXY_DECISION_API_KEY ? { apiKey: env.PROXY_DECISION_API_KEY } : {})
  };
}

/**
 * Local decision-model advisor. Never rewrites tool calls, routing identities,
 * user text or permissions. Failures leave the original LLM request intact.
 */
export class DecisionAssistant {
  constructor(
    readonly settings: DecisionSettings,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async prepare(body: JsonObject, signal?: AbortSignal, preserveContract = false): Promise<DecisionPreparation> {
    if (this.settings.mode === 'off') return { body, status: 'off' };
    const text = extractLatestUserText(body);
    if (!text) return { body, status: 'skipped' };

    try {
      const timeout = AbortSignal.timeout(this.settings.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await this.fetcher(this.settings.url + '/api/decide', {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          ...(this.settings.apiKey ? { authorization: 'Bearer ' + this.settings.apiKey } : {})
        },
        body: JSON.stringify({
          model: this.settings.model,
          preset: 'router',
          state: { request: text }
        }),
        signal: combined
      });
      if (!response.ok) throw new Error('Decision provider HTTP ' + response.status);
      const result: unknown = await response.json();
      const signals = parseSignals(result);
      // Agent-contract requests have a strict, independently validated wire format.
      // Inspect in shadow mode rather than mutating their transcript.
      if (this.settings.mode === 'shadow') return { body, status: 'shadow', signals };
      if (preserveContract) return { body, status: 'assisted', signals };
      return {
        body: { ...body, messages: [{ role: 'system', content: decisionAdvisoryMessage(signals) }, ...(body.messages as JsonValue[])] },
        status: 'assisted',
        signals
      };
    } catch {
      if (signal?.aborted) throw signal.reason;
      return { body, status: 'unavailable' };
    }
  }
}
