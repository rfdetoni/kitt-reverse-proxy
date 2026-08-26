import type { JsonObject, JsonValue, ProviderId } from '../types.js';

const PRIMARY_KEYS = new Set(['messages', 'prompt', 'question', 'query', 'conversation', 'utterance']);
const SECONDARY_KEYS = new Set(['input', 'content', 'text', 'message', 'model', 'stream', 'conversation_id', 'conversationid', 'thread_id']);
const URL_HINT = /(chat|assistant|conversation|completion|message|prompt|generate|ask|bot|ai|rpc|batchexecute)/i;
const NEGATIVE_URL_HINT = /(analytics|telemetry|metrics|log(?:ging)?|track|beacon|pixel|ads|captcha|challenge)/i;

function collectKeys(value: JsonValue, result = new Set<string>(), depth = 0): Set<string> {
  if (depth > 8 || value == null) return result;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 24)) collectKeys(item, result, depth + 1);
    return result;
  }
  if (typeof value !== 'object') return result;
  for (const [key, nested] of Object.entries(value)) {
    result.add(key.toLowerCase());
    collectKeys(nested, result, depth + 1);
  }
  return result;
}

function containsConversationalArray(value: JsonValue, depth = 0): boolean {
  if (depth > 7 || value == null) return false;
  if (Array.isArray(value)) {
    return value.some((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const keys = new Set(Object.keys(item).map((k) => k.toLowerCase()));
      return (keys.has('role') || keys.has('author') || keys.has('sender')) &&
        (keys.has('content') || keys.has('text') || keys.has('message'));
    }) || value.some((item) => containsConversationalArray(item, depth + 1));
  }
  if (typeof value === 'object') return Object.values(value).some((v) => containsConversationalArray(v, depth + 1));
  return false;
}

function containsLongUserLikeString(value: JsonValue, depth = 0): boolean {
  if (depth > 8 || value == null) return false;
  if (typeof value === 'string') return value.trim().length >= 8;
  if (Array.isArray(value)) return value.some((item) => containsLongUserLikeString(item, depth + 1));
  if (typeof value === 'object') return Object.values(value).some((item) => containsLongUserLikeString(item, depth + 1));
  return false;
}

function providerUrlBonus(provider: ProviderId, url: string): number {
  switch (provider) {
    case 'gemini': return /batchexecute|bard|gemini|generate/i.test(url) ? 25 : 0;
    case 'chatgpt': return /conversation|backend-api|completion/i.test(url) ? 25 : 0;
    case 'claude': return /completion|conversation|message/i.test(url) ? 20 : 0;
    case 'kimi': return /chat|completion|message/i.test(url) ? 20 : 0;
    case 'deepseek': return /chat|completion|message/i.test(url) ? 20 : 0;
    default: return 0;
  }
}

export function scoreRequestCandidate(url: string, body: JsonObject, resourceType: string, provider: ProviderId = 'generic'): number {
  let score = 25;
  if (['xhr', 'fetch'].includes(resourceType)) score += 10;
  if (URL_HINT.test(url)) score += 20;
  if (NEGATIVE_URL_HINT.test(url)) score -= 45;
  score += providerUrlBonus(provider, url);

  const keys = collectKeys(body);
  score += [...PRIMARY_KEYS].filter((key) => keys.has(key)).length * 15;
  score += Math.min(20, [...SECONDARY_KEYS].filter((key) => keys.has(key)).length * 4);
  if (containsConversationalArray(body)) score += 30;
  if (containsLongUserLikeString(body)) score += 5;
  return score;
}

export function scoreResponseCandidate(contentType: string, body: JsonValue | null): number {
  let score = 0;
  if (/json|event-stream|ndjson|json-seq/i.test(contentType)) score += 10;
  if (body == null) return score;
  const keys = collectKeys(body);
  const replyKeys = ['answer', 'response', 'content', 'text', 'message', 'delta', 'choices', 'output'];
  score += Math.min(30, replyKeys.filter((key) => keys.has(key)).length * 6);
  if (containsLongUserLikeString(body)) score += 5;
  return score;
}
