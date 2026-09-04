import type { JsonValue } from '../types.js';

export interface JsonSchemaIssue {
  path: string;
  message: string;
}

export interface JsonSchemaValidation {
  valid: boolean;
  issues: JsonSchemaIssue[];
}

const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_NODES = 2048;
const MAX_ISSUES = 32;
const MAX_PATTERN_LENGTH = 256;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function pointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveLocalRef(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    if (!isRecord(current)) return undefined;
    current = current[pointerToken(raw)];
  }
  return current;
}

function typeMatches(value: unknown, expected: string): boolean {
  switch (expected) {
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

export function validateJsonSchema(value: unknown, schema: unknown): JsonSchemaValidation {
  if (schema === undefined) return { valid: true, issues: [] };
  const issues: JsonSchemaIssue[] = [];
  let visited = 0;
  const root: unknown = schema;

  const issue = (path: string, message: string): void => {
    if (issues.length < MAX_ISSUES) issues.push({ path, message });
  };

  const walk = (candidate: unknown, rawSchema: unknown, path: string, depth: number): void => {
    if (issues.length >= MAX_ISSUES) return;
    if (depth > MAX_SCHEMA_DEPTH) {
      issue(path, `schema excede profundidade máxima ${MAX_SCHEMA_DEPTH}`);
      return;
    }
    visited += 1;
    if (visited > MAX_SCHEMA_NODES) {
      issue(path, `schema excede limite de ${MAX_SCHEMA_NODES} nós`);
      return;
    }

    if (rawSchema === true) return;
    if (rawSchema === false) {
      issue(path, 'valor rejeitado por schema=false');
      return;
    }
    if (!isRecord(rawSchema)) return;

    if (typeof rawSchema.$ref === 'string') {
      const resolved = resolveLocalRef(root, rawSchema.$ref);
      if (resolved === undefined) {
        issue(path, `referência local não resolvida: ${rawSchema.$ref}`);
        return;
      }
      walk(candidate, resolved, path, depth + 1);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(rawSchema, 'const') && !jsonEqual(candidate, rawSchema.const)) {
      issue(path, 'valor diferente de const');
    }

    if (Array.isArray(rawSchema.enum) && !rawSchema.enum.some((entry) => jsonEqual(candidate, entry))) {
      issue(path, 'valor fora de enum');
    }

    if (Array.isArray(rawSchema.allOf)) {
      for (const sub of rawSchema.allOf) walk(candidate, sub, path, depth + 1);
    }

    if (Array.isArray(rawSchema.anyOf) && rawSchema.anyOf.length > 0) {
      const valid = rawSchema.anyOf.some((sub) => validateJsonSchema(candidate, sub as JsonValue).valid);
      if (!valid) issue(path, 'valor não corresponde a nenhum anyOf');
    }

    if (Array.isArray(rawSchema.oneOf) && rawSchema.oneOf.length > 0) {
      const matches = rawSchema.oneOf.filter((sub) => validateJsonSchema(candidate, sub as JsonValue).valid).length;
      if (matches !== 1) issue(path, `valor corresponde a ${matches} alternativas de oneOf`);
    }

    const expectedTypes = typeof rawSchema.type === 'string'
      ? [rawSchema.type]
      : Array.isArray(rawSchema.type)
        ? rawSchema.type.filter((entry): entry is string => typeof entry === 'string')
        : [];

    if (expectedTypes.length > 0 && !expectedTypes.some((expected) => typeMatches(candidate, expected))) {
      issue(path, `tipo inválido; esperado ${expectedTypes.join('|')}`);
      return;
    }

    if (typeof candidate === 'string') {
      if (typeof rawSchema.minLength === 'number' && candidate.length < rawSchema.minLength) {
        issue(path, `string menor que minLength=${rawSchema.minLength}`);
      }
      if (typeof rawSchema.maxLength === 'number' && candidate.length > rawSchema.maxLength) {
        issue(path, `string maior que maxLength=${rawSchema.maxLength}`);
      }
      if (typeof rawSchema.pattern === 'string') {
        if (rawSchema.pattern.length > MAX_PATTERN_LENGTH) {
          issue(path, `pattern excede ${MAX_PATTERN_LENGTH} caracteres`);
        } else {
          try {
            if (!new RegExp(rawSchema.pattern, 'u').test(candidate)) issue(path, 'string não corresponde ao pattern');
          } catch {
            issue(path, 'pattern inválido');
          }
        }
      }
    }

    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      if (typeof rawSchema.minimum === 'number' && candidate < rawSchema.minimum) {
        issue(path, `número menor que minimum=${rawSchema.minimum}`);
      }
      if (typeof rawSchema.maximum === 'number' && candidate > rawSchema.maximum) {
        issue(path, `número maior que maximum=${rawSchema.maximum}`);
      }
      if (typeof rawSchema.exclusiveMinimum === 'number' && candidate <= rawSchema.exclusiveMinimum) {
        issue(path, `número deve ser > ${rawSchema.exclusiveMinimum}`);
      }
      if (typeof rawSchema.exclusiveMaximum === 'number' && candidate >= rawSchema.exclusiveMaximum) {
        issue(path, `número deve ser < ${rawSchema.exclusiveMaximum}`);
      }
    }

    if (Array.isArray(candidate)) {
      if (typeof rawSchema.minItems === 'number' && candidate.length < rawSchema.minItems) {
        issue(path, `array menor que minItems=${rawSchema.minItems}`);
      }
      if (typeof rawSchema.maxItems === 'number' && candidate.length > rawSchema.maxItems) {
        issue(path, `array maior que maxItems=${rawSchema.maxItems}`);
      }
      if (rawSchema.uniqueItems === true) {
        const encoded = candidate.map((item) => JSON.stringify(item));
        if (new Set(encoded).size !== encoded.length) issue(path, 'array viola uniqueItems');
      }
      if (rawSchema.items !== undefined) {
        candidate.forEach((item, index) => walk(item, rawSchema.items, `${path}/${index}`, depth + 1));
      }
    }

    if (isRecord(candidate)) {
      const properties = isRecord(rawSchema.properties) ? rawSchema.properties : {};
      const required = Array.isArray(rawSchema.required)
        ? rawSchema.required.filter((entry): entry is string => typeof entry === 'string')
        : [];

      for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(candidate, key)) issue(`${path}/${key}`, 'propriedade obrigatória ausente');
      }

      for (const [key, child] of Object.entries(candidate)) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) {
          walk(child, properties[key], `${path}/${key}`, depth + 1);
          continue;
        }
        if (rawSchema.additionalProperties === false) {
          issue(`${path}/${key}`, 'propriedade adicional não permitida');
        } else if (isRecord(rawSchema.additionalProperties) || typeof rawSchema.additionalProperties === 'boolean') {
          walk(child, rawSchema.additionalProperties, `${path}/${key}`, depth + 1);
        }
      }

      const count = Object.keys(candidate).length;
      if (typeof rawSchema.minProperties === 'number' && count < rawSchema.minProperties) {
        issue(path, `objeto menor que minProperties=${rawSchema.minProperties}`);
      }
      if (typeof rawSchema.maxProperties === 'number' && count > rawSchema.maxProperties) {
        issue(path, `objeto maior que maxProperties=${rawSchema.maxProperties}`);
      }
    }
  };

  walk(value, schema, '$', 0);
  return { valid: issues.length === 0, issues };
}
