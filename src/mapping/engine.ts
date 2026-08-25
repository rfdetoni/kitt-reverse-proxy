import { randomUUID } from 'node:crypto';
import type { AdapterProfile, BindingTransform, JsonObject, JsonValue, OpenAiCompletion, RequestBinding } from '../types.js';
import { cloneJson, toJsonValue } from '../util/json.js';
import { deleteJsonPath, getPathValues, setJsonPath } from '../util/path.js';
import { messageToText, normalizeMessages, transcript } from './messages.js';

function sourceValue(binding: RequestBinding, body: JsonObject): JsonValue | undefined {
  const messages = normalizeMessages(Array.isArray(body.messages) ? body.messages : undefined);
  switch (binding.source) {
    case 'openai.messages': return toJsonValue(messages.map((message) => ({ role: message.role, content: messageToText(message) })));
    case 'openai.last_user_text': return messages.filter((m) => m.role === 'user').map(messageToText).at(-1) ?? '';
    case 'openai.last_message_text': return messages.length ? messageToText(messages.at(-1)!) : '';
    case 'openai.transcript': return transcript(messages);
    case 'openai.system_text': return messages.filter((m) => m.role === 'system').map(messageToText).join('\n');
    case 'openai.model': return body.model;
    case 'openai.temperature': return body.temperature;
    case 'openai.top_p': return body.top_p;
    case 'openai.max_tokens': return body.max_tokens;
    case 'openai.stream': return body.stream;
    case 'openai.tools_json': return body.tools === undefined ? undefined : JSON.stringify(body.tools);
    case 'openai.tool_choice_json': return body.tool_choice === undefined ? undefined : JSON.stringify(body.tool_choice);
    case 'generated.uuid': return randomUUID();
    case 'generated.request_id': return `req_${randomUUID()}`;
    case 'generated.timestamp_ms': return Date.now();
    case 'generated.timestamp_s': return Math.floor(Date.now() / 1000);
  }
}

function applyTransform(value: JsonValue, transform: BindingTransform | undefined, body: JsonObject): JsonValue {
  if (!transform || transform.type === 'identity') return value;
  if (transform.type === 'string') return typeof value === 'string' ? value : JSON.stringify(value);
  const messages = normalizeMessages(Array.isArray(body.messages) ? body.messages : undefined);
  const includeSystem = transform.includeSystem !== false;
  const roleMap = transform.roleMap || {};
  return toJsonValue(messages
    .filter((message) => includeSystem || message.role !== 'system')
    .map((message) => {
      const target: JsonObject = {};
      setJsonPath(target, transform.rolePath, roleMap[message.role as keyof typeof roleMap] || message.role);
      setJsonPath(target, transform.contentPath, messageToText(message));
      return target;
    }));
}

function textFromValue(value: JsonValue): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(textFromValue);
  if (value && typeof value === 'object') return genericExtract(value);
  return [];
}

function genericExtract(value: JsonValue, depth = 0): string[] {
  if (depth > 10 || value == null) return [];
  if (typeof value === 'string') return value ? [value] : [];
  if (typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((item) => genericExtract(item, depth + 1));

  const preferred = ['answer', 'response', 'output_text', 'content', 'text', 'message', 'delta'];
  for (const key of preferred) {
    if (key in value) {
      const found = genericExtract(value[key]!, depth + 1);
      if (found.length) return found;
    }
  }
  for (const nested of Object.values(value)) {
    const found = genericExtract(nested, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function joinSmart(values: string[], separator: string): string {
  let output = '';
  for (const raw of values) {
    const next = raw.trim();
    if (!next) continue;
    if (!output) { output = next; continue; }
    if (next === output || output.endsWith(next)) continue;
    if (next.startsWith(output)) { output = next; continue; }
    output += `${separator}${next}`;
  }
  return output;
}

function joinContent(values: string[], strategy: AdapterProfile['response']['joinStrategy'], separator: string): string {
  if (values.length === 0) return '';
  switch (strategy) {
    case 'first': return values[0] ?? '';
    case 'last': return values.at(-1) ?? '';
    case 'concat': return values.join(separator);
    case 'smart':
    default: return joinSmart(values, separator);
  }
}

export class DeclarativeAdapter {
  private requestBase: JsonObject;

  constructor(
    private readonly profile: AdapterProfile,
    requestSample: JsonObject,
    private readonly defaultModel: string
  ) {
    this.requestBase = cloneJson(requestSample);
  }

  mapRequest(openAiBody: JsonObject): JsonObject {
    const output = cloneJson(this.requestBase);
    for (const path of this.profile.request.removePaths || []) deleteJsonPath(output, path);
    for (const binding of this.profile.request.bindings) {
      const raw = sourceValue(binding, openAiBody);
      if (raw === undefined) {
        if (binding.optional) continue;
        throw new Error(`Campo requerido ausente para ${binding.source}.`);
      }
      setJsonPath(output, binding.target, applyTransform(raw, binding.transform, openAiBody));
    }
    return output;
  }

  mapResponse(siteResponse: JsonValue, requestedModel?: string): OpenAiCompletion {
    const collected: string[] = [];
    for (const path of this.profile.response.contentPaths) {
      for (const value of getPathValues(siteResponse, path)) collected.push(...textFromValue(value));
    }
    if (collected.length === 0) collected.push(...genericExtract(siteResponse));
    const content = joinContent(
      collected,
      this.profile.response.joinStrategy || 'smart',
      this.profile.response.separator ?? ''
    );
    if (!content) throw new Error('Não foi possível extrair conteúdo textual da resposta do chat alvo.');

    const finishValue = this.profile.response.finishReasonPath
      ? getPathValues(siteResponse, this.profile.response.finishReasonPath)[0]
      : undefined;
    const idValue = this.profile.response.idPath
      ? getPathValues(siteResponse, this.profile.response.idPath)[0]
      : undefined;

    return {
      id: typeof idValue === 'string' ? idValue : `chatcmpl-web-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel || this.defaultModel || 'adaptive-web-proxy',
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: typeof finishValue === 'string' ? finishValue : 'stop'
      }]
    };
  }

  mapResponseDeltas(siteResponse: JsonValue): string[] {
    const rawEvents = (siteResponse && typeof siteResponse === 'object' && !Array.isArray(siteResponse))
      ? (Array.isArray(siteResponse.eventStream) ? siteResponse.eventStream : (Array.isArray(siteResponse.ndjson) ? siteResponse.ndjson : null))
      : null;

    if (!rawEvents || rawEvents.length === 0) {
      try {
        const full = this.mapResponse(siteResponse);
        const text = full.choices[0]?.message.content || '';
        return text ? [text] : [];
      } catch {
        return [];
      }
    }

    const deltas: string[] = [];
    let accumulated = '';

    for (const event of rawEvents) {
      const collected: string[] = [];
      for (const path of this.profile.response.contentPaths) {
        const eventPath = path.replace(/^\$\.(eventStream|ndjson)\[\*\]/, '$');
        for (const value of getPathValues(event, eventPath)) {
          collected.push(...textFromValue(value));
        }
      }
      if (collected.length === 0) collected.push(...genericExtract(event));
      const text = collected.filter(Boolean).join(this.profile.response.separator ?? '');
      if (!text) continue;

      if (text.startsWith(accumulated)) {
        const delta = text.slice(accumulated.length);
        if (delta) {
          deltas.push(delta);
          accumulated = text;
        }
      } else if (accumulated.endsWith(text) || text === accumulated) {
        continue;
      } else {
        deltas.push(text);
        accumulated += text;
      }
    }

    if (deltas.length === 0) {
      try {
        const full = this.mapResponse(siteResponse);
        const text = full.choices[0]?.message.content || '';
        if (text) deltas.push(text);
      } catch {
        // ignore
      }
    }
    return deltas;
  }

  applyState(siteResponse: JsonValue): void {
    for (const update of this.profile.state?.updates || []) {
      const value = getPathValues(siteResponse, update.responsePath)[0];
      if (value === undefined) {
        if (!update.optional) throw new Error(`State path ausente: ${update.responsePath}`);
        continue;
      }
      setJsonPath(this.requestBase, update.requestTarget, cloneJson(value));
    }
  }

  validate(): void {
    const sentinel = '__ADAPTIVE_PROXY_PROBE_8f6b7c__';
    const mapped = this.mapRequest({ messages: [{ role: 'user', content: sentinel }] });
    if (!JSON.stringify(mapped).includes(sentinel)) {
      throw new Error('Profile falhou no probe: conteúdo do usuário não chegou ao request alvo.');
    }
  }
}
