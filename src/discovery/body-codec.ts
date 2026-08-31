import type { JsonObject, JsonValue, RequestBodyCodecDescriptor } from '../types.js';
import { cloneJson, isJsonObject } from '../util/json.js';
import { appendJsonPath, getPathValues, parseJsonPath, setJsonPath } from '../util/path.js';

const MAX_NESTED_JSON_BYTES = 1024 * 1024;
const STRUCTURED_FORM_FIELDS = /^(f\.req|payload|data|request|params|variables|body)$/i;

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

function isStructured(value: JsonValue | undefined): value is JsonObject | JsonValue[] {
  return Array.isArray(value) || isJsonObject(value);
}

function decodeNestedJsonStrings(value: JsonValue, path: string, paths: string[], depth = 0): JsonValue {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_NESTED_JSON_BYTES || !/^[\[{]/.test(trimmed)) return value;
    const parsed = parseJson(trimmed);
    if (!isStructured(parsed)) return value;
    paths.push(path);
    return decodeNestedJsonStrings(parsed, path, paths, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.map((child, index) => decodeNestedJsonStrings(child, appendJsonPath(path, index), paths, depth + 1));
  }
  if (typeof value === 'object') {
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = decodeNestedJsonStrings(child, appendJsonPath(path, key), paths, depth + 1);
    }
    return result;
  }
  return value;
}

function decodeFormValue(key: string, raw: string, path: string, jsonStringPaths: string[]): JsonValue {
  if (!STRUCTURED_FORM_FIELDS.test(key)) return raw;
  const parsed = parseJson(raw);
  if (!isStructured(parsed)) return raw;
  return decodeNestedJsonStrings(parsed, path, jsonStringPaths);
}

function decodeForm(text: string): { body: JsonObject; codec: RequestBodyCodecDescriptor } | null {
  const entries = [...new URLSearchParams(text).entries()];
  if (!entries.length) return null;

  const grouped = new Map<string, string[]>();
  const formFieldOrder: string[] = [];
  for (const [key, raw] of entries) {
    formFieldOrder.push(key);
    const values = grouped.get(key) ?? [];
    values.push(raw);
    grouped.set(key, values);
  }

  const body: JsonObject = {};
  const jsonStringPaths: string[] = [];
  const repeatedFormKeys: string[] = [];
  for (const [key, values] of grouped) {
    if (values.length > 1) {
      repeatedFormKeys.push(key);
      body[key] = values.map((raw, index) => decodeFormValue(key, raw, appendJsonPath(appendJsonPath('$', key), index), jsonStringPaths));
    } else {
      body[key] = decodeFormValue(key, values[0]!, appendJsonPath('$', key), jsonStringPaths);
    }
  }
  return {
    body,
    codec: {
      kind: 'form',
      jsonStringPaths,
      ...(repeatedFormKeys.length ? { repeatedFormKeys } : {}),
      formFieldOrder
    }
  };
}

export function decodeRequestBody(text: string, contentType = ''): { body: JsonObject; codec: RequestBodyCodecDescriptor } | null {
  if (!text) return null;

  if (!/application\/x-www-form-urlencoded/i.test(contentType)) {
    const parsed = parseJson(text);
    if (isJsonObject(parsed)) {
      const jsonStringPaths: string[] = [];
      return { body: decodeNestedJsonStrings(parsed, '$', jsonStringPaths) as JsonObject, codec: { kind: 'json', jsonStringPaths } };
    }
  }

  const form = decodeForm(text);
  if (form) return form;

  const parsed = parseJson(text);
  if (isJsonObject(parsed)) {
    const jsonStringPaths: string[] = [];
    return { body: decodeNestedJsonStrings(parsed, '$', jsonStringPaths) as JsonObject, codec: { kind: 'json', jsonStringPaths } };
  }
  return null;
}

function pathDepth(path: string): number {
  return parseJsonPath(path).length;
}

function reencodeJsonStrings(body: JsonObject, paths: string[]): JsonObject {
  const output = cloneJson(body);
  const ordered = [...new Set(paths)].sort((a, b) => pathDepth(b) - pathDepth(a));
  for (const path of ordered) {
    const value = getPathValues(output, path)[0];
    if (value === undefined || typeof value === 'string') continue;
    setJsonPath(output, path, JSON.stringify(value));
  }
  return output;
}

function formScalar(value: JsonValue): string {
  if (value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function encodeRequestBody(body: JsonObject, codec: RequestBodyCodecDescriptor): JsonObject | string {
  const encoded = reencodeJsonStrings(body, codec.jsonStringPaths);
  if (codec.kind === 'json') return encoded;

  const params = new URLSearchParams();
  const order = codec.formFieldOrder;
  if (order?.length) {
    const offsets = new Map<string, number>();
    const seen = new Set<string>();
    for (const key of order) {
      seen.add(key);
      const value = encoded[key];
      if (Array.isArray(value) && codec.repeatedFormKeys?.includes(key)) {
        const offset = offsets.get(key) ?? 0;
        if (offset < value.length) params.append(key, formScalar(value[offset]!));
        offsets.set(key, offset + 1);
      } else if (value !== undefined) {
        if ((offsets.get(key) ?? 0) === 0) params.append(key, formScalar(value));
        offsets.set(key, 1);
      }
    }
    for (const [key, value] of Object.entries(encoded)) {
      if (seen.has(key)) continue;
      if (Array.isArray(value) && codec.repeatedFormKeys?.includes(key)) {
        for (const item of value) params.append(key, formScalar(item));
      } else params.append(key, formScalar(value));
    }
    return params.toString();
  }

  for (const [key, value] of Object.entries(encoded)) {
    if (Array.isArray(value) && codec.repeatedFormKeys?.includes(key)) {
      for (const item of value) params.append(key, formScalar(item));
    } else params.append(key, formScalar(value));
  }
  return params.toString();
}
