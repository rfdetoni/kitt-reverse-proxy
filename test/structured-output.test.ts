import test from 'node:test';
import assert from 'node:assert/strict';
import { structuredOutputPlan, validateStructuredOutput } from '../src/runtime/structured-output.js';

test('structured output extracts JSON from markdown and canonicalizes it', () => {
  const plan = structuredOutputPlan({
    messages: [{ role: 'user', content: 'x' }],
    response_format: { type: 'json_object' }
  });
  assert.ok(plan);
  const result = validateStructuredOutput('```json\n{"ok":true}\n```', plan!);
  assert.equal(result.ok, true);
  assert.equal(result.text, '{"ok":true}');
});

test('json_schema rejects schema mismatch', () => {
  const plan = structuredOutputPlan({
    messages: [{ role: 'user', content: 'x' }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        schema: {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
          additionalProperties: false
        }
      }
    }
  });
  assert.ok(plan);
  assert.equal(validateStructuredOutput('{"count":"bad"}', plan!).ok, false);
});

test('structured output rejects multiple payloads and honors array-root schemas', () => {
  const objectPlan = structuredOutputPlan({response_format:{type:'json_object'}})!;
  assert.equal(validateStructuredOutput('{"ok":true}\n{"ok":false}', objectPlan).ok, false);
  const arrayPlan = structuredOutputPlan({response_format:{type:'json_schema',json_schema:{schema:{type:'array',items:{type:'integer'}}}}})!;
  assert.deepEqual(validateStructuredOutput('[1,2,]', arrayPlan), {ok:true,text:'[1,2]'});
});
