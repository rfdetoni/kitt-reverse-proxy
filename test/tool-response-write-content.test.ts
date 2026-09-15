import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolProtocolPlan } from '../src/mapping/tool-calling.js';
import { parseUiToolResponse } from '../src/runtime/tool-response.js';

test('repairs raw quotes inside write content', () => {
  const plan = buildToolProtocolPlan({ tools: [{ type: 'function', function: { name: 'write_file' } }] });
  const response = '<tool_call>{"name":"write_file","arguments":{"path":"src/app.ts","content":"const title = "Example";"}}</tool_call>';
  const parsed = parseUiToolResponse(response, plan, [], 'gemini');
  const args = JSON.parse(parsed.tool_calls![0]!.function.arguments);
  assert.equal(args.path, 'src/app.ts');
  assert.equal(args.content, 'const title = "Example";');
});
