import type { JsonObject, JsonValue } from '../types.js';
import { validateJsonSchema } from '../util/json-schema.js';

const MAX_SCHEMA_BYTES = 64 * 1024;

export interface StructuredOutputPlan {
  type: 'json_object' | 'json_schema';
  schema?: JsonValue;
  instruction: string;
}

export interface StructuredValidation {
  ok: boolean;
  text: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compact(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Schema de structured output não é serializável.');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_SCHEMA_BYTES) {
    throw new Error(`Schema de structured output excede ${MAX_SCHEMA_BYTES} bytes.`);
  }
  return encoded;
}

export function structuredOutputPlan(body: JsonObject): StructuredOutputPlan | undefined {
  const raw = isRecord(body.response_format) ? body.response_format : undefined;
  if (!raw || typeof raw.type !== 'string') return undefined;
  if (raw.type === 'json_object') {
    return {
      type: 'json_object',
      instruction: 'Respond ONLY with a valid JSON object. No markdown, no explanation.'
    };
  }
  if (raw.type !== 'json_schema') return undefined;

  const nested = isRecord(raw.json_schema) ? raw.json_schema : undefined;
  const schema = (nested?.schema ?? raw.schema) as JsonValue | undefined;
  if (schema === undefined) {
    throw new Error('response_format.type=json_schema exige json_schema.schema.');
  }
  return {
    type: 'json_schema',
    schema,
    instruction: `Respond ONLY with JSON matching this schema: ${compact(schema)}`
  };
}

export function hasStructuredOutputRequest(body: JsonObject): boolean {
  return structuredOutputPlan(body) !== undefined;
}

function objectFromParsed(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function parsePure(text: string): Record<string, unknown> | undefined {
  try {
    return objectFromParsed(JSON.parse(text.trim()));
  } catch {
    return undefined;
  }
}

function parseCodeBlock(text: string): Record<string, unknown> | undefined {
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
    const parsed = parsePure(match[1] || '');
    if (parsed) return parsed;
  }
  return undefined;
}

function firstBalancedObject(text: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

export function validateStructuredOutput(text: string, plan: StructuredOutputPlan): StructuredValidation {
  const parsed = parsePure(text) ?? parseCodeBlock(text) ?? (() => {
    const candidate = firstBalancedObject(text);
    return candidate ? parsePure(candidate) : undefined;
  })();

  if (!parsed) return { ok: false, text, error: 'response is not a valid JSON object' };

  if (plan.schema !== undefined) {
    const validation = validateJsonSchema(parsed, plan.schema);
    if (!validation.valid) {
      return {
        ok: false,
        text,
        error: validation.issues.slice(0, 6).map((entry) => `${entry.path}: ${entry.message}`).join('; ')
      };
    }
  }

  return { ok: true, text: JSON.stringify(parsed) };
}

export function buildStructuredRetryPrompt(plan: StructuredOutputPlan, error?: string): string {
  if (plan.type === 'json_schema' && plan.schema !== undefined) {
    return `Your response was not valid JSON matching the requested schema${error ? ` (${error.slice(0, 400)})` : ''}. Respond ONLY with JSON matching this schema: ${compact(plan.schema)}`;
  }
  return `Your response was not valid JSON${error ? ` (${error.slice(0, 400)})` : ''}. Respond ONLY with a JSON object.`;
}
