import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolProtocolPlan, ToolProtocolError } from '../src/mapping/tool-calling.js';
import { parseUiToolResponse } from '../src/runtime/tool-response.js';

const runtimePlan = buildToolProtocolPlan({
  tools: [{
    type: 'function',
    function: {
      name: 'kitt_runtime',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string' },
          arguments: { type: 'object', additionalProperties: true }
        },
        required: ['operation', 'arguments'],
        additionalProperties: true
      }
    }
  }],
  parallel_tool_calls: false
});

test('visible tool call preserves source-code escapes that are invalid JSON escapes', () => {
  const response = String.raw`<tool_call>{"name":"kitt_runtime","arguments":{"operation":"repo.write_file","arguments":{"path":"scriptContext/generate_context.py","content":"if b\"\x00\" in chunk:\n    return False\npattern = r\"\d+\""}}}</tool_call>`;

  const parsed = parseUiToolResponse(response, runtimePlan, [], 'gemini');
  assert.equal(parsed.tool_calls?.length, 1);
  const args = JSON.parse(parsed.tool_calls?.[0]?.function.arguments || '{}');
  assert.equal(args.operation, 'repo.write_file');
  assert.equal(args.arguments.path, 'scriptContext/generate_context.py');
  assert.match(args.arguments.content, /b"\\x00"/);
  assert.match(args.arguments.content, /r"\\d\+"/);
});

test('raw control characters inside source strings are escaped without changing content', () => {
  const response = `<tool_call>{"name":"kitt_runtime","arguments":{"operation":"repo.write_file","arguments":{"path":"x.txt","content":"line one
line two"}}}</tool_call>`;

  const parsed = parseUiToolResponse(response, runtimePlan, [], 'gemini');
  const args = JSON.parse(parsed.tool_calls?.[0]?.function.arguments || '{}');
  assert.equal(args.arguments.content, 'line one\nline two');
});

test('structurally malformed tool JSON still fails closed', () => {
  const response = '<tool_call>{"name":"kitt_runtime","arguments":{"operation":"repo.write_file"</tool_call>';
  assert.throws(
    () => parseUiToolResponse(response, runtimePlan, [], 'gemini'),
    ToolProtocolError
  );
});
