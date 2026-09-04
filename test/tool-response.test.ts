import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolProtocolPlan } from '../src/mapping/tool-calling.js';
import { parseUiToolResponse, ToolParseFailedError } from '../src/runtime/tool-response.js';

test('tool_call fenced block is normalized and parsed', () => {
  const plan = buildToolProtocolPlan({
    messages: [],
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false
        }
      }
    }]
  });
  const parsed = parseUiToolResponse('```tool_call\n{"name":"read_file","arguments":{"path":"README.md"}}\n```', plan);
  assert.equal(parsed.tool_calls?.[0]?.function.name, 'read_file');
});

test('schema-invalid tool arguments fail closed', () => {
  const plan = buildToolProtocolPlan({
    messages: [],
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false
        }
      }
    }]
  });
  assert.throws(
    () => parseUiToolResponse('<tool_call>{"name":"read_file","arguments":{"path":3}}</tool_call>', plan),
    ToolParseFailedError
  );
});
