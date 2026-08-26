import type { JsonObject, JsonValue, RequestBodyCodecDescriptor } from '../types.js';
import { cloneJson, isJsonObject } from '../util/json.js';
import { appendJsonPath, getPathValues, setJsonPath } from '../util/path.js';

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
  if (depth > 5 || value == null) return value;
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

function decodeForm(text: string): { body: JsonObject; codec: RequestBodyCodecDescriptor } | null {
  const params = new URLSearchParams(text);
  const entries = [...params.entries()];
  if (!entries.length) return null;

  const body: JsonObject = {};
  const jsonStringPaths: string[] = [];
  for (const [key, raw] of entries) {
    const rootPath = appendJsonPath('$', key);
    if (!STRUCTURED_FORM_FIELDS.test(key)) {
      body[key] = raw;
      continue;
    }
    const parsed = parseJson(raw);
    if (!isStructured(parsed)) {
      body[key] = raw;
      continue;
    }
    body[key] = decodeNestedJsonStrings(parsed, rootPath, jsonStringPaths);
  }
  return { body, codec: { kind: 'form', jsonStringPaths } };
}

export function decodeRequestBody(text: string, contentType = ''): { body: JsonObject; codec: RequestBodyCodecDescriptor } | null {
  if (!text) return null;

  if (!/application\/x-www-form-urlencoded/i.test(contentType)) {
    const parsed = parseJson(text);
    if (isJsonObject(parsed)) return { body: parsed, codec: { kind: 'json', jsonStringPaths: [] } };
  }

  const form = decodeForm(text);
  if (form) return form;

  const parsed = parseJson(text);
  if (isJsonObject(parsed)) return { body: parsed, codec: { kind: 'json', jsonStringPaths: [] } };
  return null;
}

function pathDepth(path: string): number {
  return (path.match(/\.|\[/g) || []).length;
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

export function encodeRequestBody(body: JsonObject, codec: RequestBodyCodecDescriptor): JsonObject | string {
  const encoded = reencodeJsonStrings(body, codec.jsonStringPaths);
  if (codec.kind === 'json') return encoded;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(encoded)) {
    if (value === null) params.set(key, '');
    else if (typeof value === 'string') params.set(key, value);
    else if (typeof value === 'number' || typeof value === 'boolean') params.set(key, String(value));
    else params.set(key, JSON.stringify(value));
  }
  return params.toString();
}
