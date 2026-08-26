import type { JsonValue } from '../types.js';

const SECRET_KEY = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|session|credential|csrf|xsrf)/i;
const TEXT_KEY = /^(content|text|prompt|query|input|question|answer|message)$/i;
const ID_KEY = /(^|_)(id|uuid|conversationid|conversation_id|messageid|message_id)$/i;
const STRUCTURAL_STRING_KEY = /^(role|type|kind|mode|model|method|operation|action|format|language|locale|stream)$/i;

export function redactForModel(value: JsonValue, key = '', depth = 0): JsonValue {
  if (depth > 12) return '[MAX_DEPTH]';
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => redactForModel(item, key, depth + 1));
  if (value && typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const [childKey, childValue] of Object.entries(value)) output[childKey] = redactForModel(childValue, childKey, depth + 1);
    return output;
  }
  if (typeof value === 'string') {
    if (TEXT_KEY.test(key)) return '[TEXT]';
    if (ID_KEY.test(key) && value.length >= 8) return '[ID]';
    if (STRUCTURAL_STRING_KEY.test(key) && value.length <= 96) return value;
    // The mapper needs shape, not user content. Preserve only length for arbitrary strings.
    return `[STRING:${value.length}]`;
  }
  return value;
}

export function redactHeadersForModel(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : `[HEADER:${value.length}]`])
  );
}
