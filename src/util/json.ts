import type { JsonObject, JsonValue } from '../types.js';

export function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Valor não serializável como JSON.');
  return JSON.parse(serialized) as JsonValue;
}

export function assertJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${label} deve ser um objeto JSON.`);
  return value;
}

export function byteLengthOfJson(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) return Number.POSITIVE_INFINITY;
  return Buffer.byteLength(json, 'utf8');
}
