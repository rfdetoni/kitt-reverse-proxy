import type { JsonValue } from '../types.js';

const SECRET_KEY = /(authorization|cookie|token|secret|password|passwd|api[-_]?key|session|credential|csrf|xsrf)/i;
const TEXT_KEY = /^(content|text|prompt|query|input|question|answer|message)$/i;
const ID_KEY = /(^|_)(id|uuid|conversationid|conversation_id|messageid|message_id)$/i;
const STRUCTURAL_STRING_KEY = /^(role|type|kind|mode|model|method|operation|action|format|language|locale|stream)$/i;
const MAX_DEPTH = 12;
const MAX_ARRAY_ITEMS = 30;
const MAX_OBJECT_KEYS = 80;
const MAX_NODES = 5_000;

interface Budget { nodes: number }

function redact(value: JsonValue, key: string, depth: number, budget: Budget): JsonValue {
  budget.nodes += 1;
  if (budget.nodes > MAX_NODES) return '[TRUNCATED]';
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) {
    const output = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, key, depth + 1, budget));
    if (value.length > MAX_ARRAY_ITEMS) output.push(`[TRUNCATED:${value.length - MAX_ARRAY_ITEMS}]`);
    return output;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    const entries = Object.entries(value);
    for (const [childKey, childValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
      output[childKey] = redact(childValue, childKey, depth + 1, budget);
    }
    if (entries.length > MAX_OBJECT_KEYS) output.__truncated__ = entries.length - MAX_OBJECT_KEYS;
    return output;
  }
  if (typeof value === 'string') {
    if (TEXT_KEY.test(key)) return '[TEXT]';
    if (ID_KEY.test(key) && value.length >= 8) return '[ID]';
    if (STRUCTURAL_STRING_KEY.test(key) && value.length <= 96) return value;
    return `[STRING:${value.length}]`;
  }
  return value;
}

export function redactForModel(value: JsonValue, key = '', depth = 0): JsonValue {
  return redact(value, key, depth, { nodes: 0 });
}

export function redactHeadersForModel(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).slice(0, 100).map(([key, value]) => [key, SECRET_KEY.test(key) ? '[REDACTED]' : `[HEADER:${value.length}]`])
  );
}
