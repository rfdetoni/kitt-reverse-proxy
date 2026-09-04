import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJsonSchema } from '../src/util/json-schema.js';

test('json schema validates required properties and additionalProperties=false', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string', minLength: 1 } },
    required: ['path'],
    additionalProperties: false
  } as const;
  assert.equal(validateJsonSchema({ path: 'a.txt' }, schema).valid, true);
  assert.equal(validateJsonSchema({ path: '', extra: true }, schema).valid, false);
});

test('json schema resolves local refs', () => {
  const schema = {
    $defs: { id: { type: 'string', pattern: '^[A-Za-z0-9]+$' } },
    type: 'object',
    properties: { id: { $ref: '#/$defs/id' } },
    required: ['id']
  } as const;
  assert.equal(validateJsonSchema({ id: 'abc123' }, schema).valid, true);
  assert.equal(validateJsonSchema({ id: 'bad-id' }, schema).valid, false);
});
