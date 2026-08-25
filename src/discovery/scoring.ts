import type { JsonObject, JsonValue } from '../types.js';

const PRIMARY_KEYS = new Set(['messages', 'prompt', 'question', 'query', 'conversation', 'utterance']);
const SECONDARY_KEYS = new Set(['input', 'content', 'text', 'message', 'model', 'stream', 'conversation_id', 'conversationid']);
const URL_HINT = /(chat|assistant|conversation|completion|message|prompt|generate|ask|bot|ai)/i;
const NEGATIVE_URL_HINT = /(analytics|telemetry|metrics|log|event|track|beacon|pixel|ads|captcha)/i;

function collectKeys(value: JsonValue, result = new Set<string>(), depth = 0): Set<string> {
  if (depth > 7 || value == null) return result;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collectKeys(item, result, depth + 1);
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
  if (depth > 6 || value == null) return false;
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

export function scoreRequestCandidate(url: string, body: JsonObject, resourceType: string): number {
  let score = 25;
  if (['xhr', 'fetch'].includes(resourceType)) score += 10;
  if (URL_HINT.test(url)) score += 20;
  if (NEGATIVE_URL_HINT.test(url)) score -= 45;

  const keys = collectKeys(body);
  score += [...PRIMARY_KEYS].filter((key) => keys.has(key)).length * 15;
  score += Math.min(20, [...SECONDARY_KEYS].filter((key) => keys.has(key)).length * 4);
  if (containsConversationalArray(body)) score += 30;
  return score;
}

export function scoreResponseCandidate(contentType: string, body: JsonValue | null): number {
  let score = 0;
  if (/json|event-stream|ndjson/i.test(contentType)) score += 10;
  if (body == null) return score;
  const keys = collectKeys(body);
  const replyKeys = ['answer', 'response', 'content', 'text', 'message', 'delta', 'choices'];
  score += Math.min(30, replyKeys.filter((key) => keys.has(key)).length * 6);
  return score;
}
