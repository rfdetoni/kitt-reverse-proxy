import { createHash } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export interface JsonSchemaIssue { path: string; message: string; }
export interface JsonSchemaValidation { valid: boolean; issues: JsonSchemaIssue[]; }
export class InvalidJsonSchemaError extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidJsonSchemaError'; }
}
const options = { strict: true, strictTypes: false, strictTuples: false, strictRequired: false,
  allowMatchingProperties: true, allowUnionTypes: true, allErrors: false,
  coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: true, addUsedSchema: false };
const validators = { draft7: new Ajv(options), draft2019: new Ajv2019(options), draft2020: new Ajv2020(options) };
for (const validator of Object.values(validators)) addFormats.default(validator);
const cache = new Map<string, ValidateFunction>();
const pointerToken = (value: unknown): string => String(value).replace(/~/g, '~0').replace(/\//g, '~1');

function compile(schema: unknown): ValidateFunction {
  const encoded = JSON.stringify(schema);
  if (!encoded || Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw new InvalidJsonSchemaError('JSON Schema exceeds 64 KiB or is not serializable.');
  const key = createHash('sha256').update(encoded).digest('hex');
  const found = cache.get(key);
  if (found) return found;
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 32 || ++nodes > 4096) throw new InvalidJsonSchemaError('JSON Schema complexity limit exceeded.');
    if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) {
        if (name === '$async' && child === true) throw new InvalidJsonSchemaError('Async JSON Schema is unsupported.');
        if (name === 'pattern' && typeof child === 'string' && child.length > 256) throw new InvalidJsonSchemaError('Schema pattern exceeds 256 characters.');
        visit(child, depth + 1);
      }
    }
  };
  visit(schema, 0);
  const dialect = schema && typeof schema === 'object' ? (schema as { $schema?: unknown }).$schema : undefined;
  const ajv = typeof dialect === 'string' && dialect.includes('2020-12') ? validators.draft2020
    : typeof dialect === 'string' && dialect.includes('2019-09') ? validators.draft2019 : validators.draft7;
  let validate: ValidateFunction;
  try { validate = ajv.compile(schema as object | boolean); }
  catch (error) { throw new InvalidJsonSchemaError(`Invalid or unsupported JSON Schema: ${error instanceof Error ? error.message : String(error)}`); }
  if (cache.size >= 256) {
    const oldest = cache.keys().next().value!;
    const evicted = cache.get(oldest)!;
    for (const validator of Object.values(validators)) validator.removeSchema(evicted.schema);
    cache.delete(oldest);
  }
  cache.set(key, validate);
  return validate;
}

/** Compile/reject caller schemas before allocating or submitting to a provider. */
export function assertSupportedJsonSchema(schema: unknown): void { compile(schema); }

export function validateJsonSchema(value: unknown, schema: unknown): JsonSchemaValidation {
  if (schema === undefined) return { valid: true, issues: [] };
  const validate = compile(schema);
  const valid = validate(value) as boolean;
  return { valid, issues: (validate.errors ?? []).slice(0, 6).map((error) => ({
    path: `$${error.instancePath}${error.keyword === 'required' ? `/${pointerToken(error.params.missingProperty)}`
      : error.keyword === 'additionalProperties' ? `/${pointerToken(error.params.additionalProperty)}` : ''}`,
    message: error.message ?? error.keyword
  })) };
}
