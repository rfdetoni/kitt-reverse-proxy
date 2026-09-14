import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolProtocolPlan } from '../src/mapping/tool-calling.js';
import {
  buildToolRetryPrompt,
  parseUiToolResponse,
  ToolParseFailedError
} from '../src/runtime/tool-response.js';

function readFilePlan() {
  return buildToolProtocolPlan({
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
}

test('tool_call fenced block is normalized and parsed', () => {
  const parsed = parseUiToolResponse(
    '```tool_call\n{"name":"read_file","arguments":{"path":"README.md"}}\n```',
    readFilePlan()
  );
  assert.equal(parsed.tool_calls?.[0]?.function.name, 'read_file');
});

test('duplicated nested tool_call marker recovers innermost valid Gemini call', () => {
  const response = '<tool_call>{"name":"read_file","arguments":{"path":"broken","<tool_call>{"name":"read_file","arguments":{"path":"README.md"}}</tool_call>';
  const parsed = parseUiToolResponse(response, readFilePlan(), [], 'gemini');

  assert.equal(parsed.tool_calls?.length, 1);
  assert.equal(parsed.tool_calls?.[0]?.function.name, 'read_file');
  assert.deepEqual(JSON.parse(parsed.tool_calls?.[0]?.function.arguments ?? '{}'), {
    path: 'README.md'
  });
});

test('schema-invalid tool arguments fail closed', () => {
  assert.throws(
    () => parseUiToolResponse(
      '<tool_call>{"name":"read_file","arguments":{"path":3}}</tool_call>',
      readFilePlan()
    ),
    ToolParseFailedError
  );
});

test('tool retry keeps canonical tool_call envelope instead of switching to bare JSON', () => {
  const retry = buildToolRetryPrompt(readFilePlan(), 'invalid tool call');

  assert.match(retry, /<tool_call>\{"name":"ALLOWED_TOOL_NAME","arguments":\{\}\}<\/tool_call>/);
  assert.match(retry, /do not switch to bare JSON/i);
  assert.doesNotMatch(retry, /Respond ONLY with valid JSON matching/i);
});

test('artifacts never synthesize local writes and disabled tools remain text', () => {
  const tools = [{ type: 'function', function: { name: 'write_file' } }];
  const plan = buildToolProtocolPlan({ tools });
  assert.deepEqual(parseUiToolResponse('Example code', plan, [{ code: 'hello' }]), {
    content: 'Example code'
  });
  const disabled = buildToolProtocolPlan({ tools, tool_choice: 'none' });
  const text = '<tool_call>{"name":"write_file","arguments":{}}</tool_call>';
  assert.deepEqual(parseUiToolResponse(text, disabled), { content: text });
});
