import type { AdapterProfile, JsonObject, JsonValue, RequestBinding, StateUpdate } from '../types.js';
import { appendJsonPath } from '../util/path.js';

interface FoundPath { path: string; key: string; value: JsonValue }

function walk(value: JsonValue, path = '$', output: FoundPath[] = [], depth = 0): FoundPath[] {
  if (depth > 8 || value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 5)) walk(item, `${path}[*]`, output, depth + 1);
    return output;
  }
  if (typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    const childPath = appendJsonPath(path, key);
    output.push({ path: childPath, key: key.toLowerCase(), value: child });
    walk(child, childPath, output, depth + 1);
  }
  return output;
}

function messageShape(value: JsonValue): { rolePath: string; contentPath: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const paths = walk(value);
  const role = paths.find((item) => /^(role|author|sender)$/i.test(item.key) && typeof item.value === 'string');
  const content = paths.find((item) => /^(content|text|message|utterance)$/i.test(item.key) && typeof item.value === 'string');
  if (!role || !content) return null;
  return {
    rolePath: role.path.replace(/\[\*\]/g, '[0]'),
    contentPath: content.path.replace(/\[\*\]/g, '[0]')
  };
}

function findRequestBinding(sample: JsonObject): RequestBinding {
  const paths = walk(sample);
  const messages = paths.find((item) => {
    if (!Array.isArray(item.value) || item.value.length === 0 || item.path.includes('[*]')) return false;
    return messageShape(item.value[0]!) !== null;
  });
  if (messages) {
    const messageArray = messages.value as JsonValue[];
    const shape = messageShape(messageArray[0]!);
    if (shape) {
      return { target: messages.path, source: 'openai.messages', transform: { type: 'message_array', ...shape } };
    }
    return { target: messages.path, source: 'openai.messages' };
  }

  const textPriority = ['prompt', 'query', 'question', 'input', 'utterance', 'text', 'message'];
  for (const key of textPriority) {
    const found = paths.find((item) => item.key === key && typeof item.value === 'string' && !item.path.includes('[*]'));
    if (found) return { target: found.path, source: 'openai.last_user_text' };
  }
  return { target: '$.messages', source: 'openai.messages' };
}

function optionalBindings(sample: JsonObject): RequestBinding[] {
  const paths = walk(sample);
  const mappings: Array<[string, RequestBinding['source']]> = [
    ['model', 'openai.model'], ['temperature', 'openai.temperature'], ['top_p', 'openai.top_p'],
    ['max_tokens', 'openai.max_tokens'], ['max_completion_tokens', 'openai.max_tokens'], ['stream', 'openai.stream']
  ];
  const result: RequestBinding[] = [];
  for (const [key, source] of mappings) {
    const found = paths.find((item) => item.key === key);
    if (found) result.push({ target: found.path, source, optional: true });
  }
  for (const item of paths) {
    if (item.path.includes('[*]')) continue;
    if (/^(message_?id|request_?id|client_?request_?id)$/i.test(item.key) && typeof item.value === 'string') {
      result.push({ target: item.path, source: 'generated.uuid', optional: true });
    }
    if (/^(timestamp|timestamp_ms|client_timestamp)$/i.test(item.key) && typeof item.value === 'number') {
      result.push({ target: item.path, source: 'generated.timestamp_ms', optional: true });
    }
  }
  return result.slice(0, 16);
}

function responsePaths(sample: JsonValue | null): string[] {
  if (!sample) return [];
  const paths = walk(sample);
  const scores = new Map<string, number>();
  const weight: Record<string, number> = { answer: 100, response: 95, output_text: 95, content: 90, text: 85, delta: 80, message: 70 };
  for (const item of paths) {
    if (typeof item.value !== 'string') continue;
    const base = weight[item.key] || 0;
    if (!base) continue;
    const normalized = item.path.replace(/\[\*\](?=\.|$)/g, '[*]');
    scores.set(normalized, Math.max(scores.get(normalized) || 0, base));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([path]) => path);
}

function stateUpdates(request: JsonObject, response: JsonValue | null): StateUpdate[] {
  if (!response) return [];
  const reqPaths = walk(request);
  const resPaths = walk(response);
  const result: StateUpdate[] = [];
  const stateKeys = /^(conversation_?id|thread_?id|session_?id|context_?id)$/i;
  for (const req of reqPaths) {
    if (req.path.includes('[*]') || !stateKeys.test(req.key)) continue;
    const res = resPaths.find((candidate) => candidate.key === req.key && typeof candidate.value === typeof req.value);
    if (res) result.push({ responsePath: res.path, requestTarget: req.path, optional: true });
  }
  return result.slice(0, 8);
}

export function createFallbackProfile(requestSample: JsonObject, responseSample: JsonValue | null, endpointUrl: string): AdapterProfile {
  const primary = findRequestBinding(requestSample);
  const extra = optionalBindings(requestSample).filter((binding) => binding.target !== primary.target);
  const updates = stateUpdates(requestSample, responseSample);
  const endpoint = new URL(endpointUrl);
  return {
    version: 2,
    request: { bindings: [primary, ...extra] },
    response: { contentPaths: responsePaths(responseSample), joinStrategy: 'smart', separator: '' },
    ...(updates.length ? { state: { updates } } : {}),
    metadata: { targetHost: endpoint.hostname, endpointPath: endpoint.pathname, generatedBy: 'fallback' }
  };
}
