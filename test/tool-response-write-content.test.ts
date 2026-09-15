import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolProtocolPlan } from '../src/mapping/tool-calling.js';
import { parseUiToolResponse } from '../src/runtime/tool-response.js';

function writePlan() {
  return buildToolProtocolPlan({
    tools: [{
      type: 'function',
      function: {
        name: 'write_file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['path', 'content'],
          additionalProperties: false
        }
      }
    }]
  });
}

test('repairs raw quotes inside write content', () => {
  const response = '<tool_call>{"name":"write_file","arguments":{"path":"src/app.ts","content":"const title = "Example";"}}</tool_call>';
  const parsed = parseUiToolResponse(response, writePlan(), [], 'gemini');
  const args = JSON.parse(parsed.tool_calls![0]!.function.arguments);
  assert.equal(args.path, 'src/app.ts');
  assert.equal(args.content, 'const title = "Example";');
});

test('hydrates missing write content from a matching UI artifact before schema validation', () => {
  const response = '<tool_call>{"name":"write_file","arguments":{"path":"src/app.ts"}}</tool_call>';
  const parsed = parseUiToolResponse(
    response,
    writePlan(),
    [{ filename: 'src/app.ts', language: 'typescript', code: 'export const ready = true;\n' }],
    'gemini'
  );
  const args = JSON.parse(parsed.tool_calls![0]!.function.arguments);
  assert.equal(args.path, 'src/app.ts');
  assert.equal(args.content, 'export const ready = true;\n');
});

test('does not guess between multiple unmatched UI artifacts', () => {
  const response = '<tool_call>{"name":"write_file","arguments":{"path":"src/app.ts"}}</tool_call>';
  assert.throws(() => parseUiToolResponse(
    response,
    writePlan(),
    [
      { filename: 'src/a.ts', code: 'a' },
      { filename: 'src/b.ts', code: 'b' }
    ],
    'gemini'
  ));
});
