import test from 'node:test';
import assert from 'node:assert/strict';
import { extractToolCalls, formatToolsInstruction, injectToolsIntoPrompt } from '../src/mapping/tool-calling.js';

test('formatToolsInstruction formats tool definitions', () => {
  const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Get weather' } }];
  const formatted = formatToolsInstruction(tools);
  assert.match(formatted, /get_weather/);
  assert.match(formatted, /tool_calls/);
});

test('injectToolsIntoPrompt prepends instructions when tools provided', () => {
  const tools = [{ type: 'function', function: { name: 'calculator' } }];
  const prompt = injectToolsIntoPrompt('What is 2+2?', tools);
  assert.match(prompt, /calculator/);
  assert.match(prompt, /What is 2\+2\?/);
});

test('extractToolCalls parses <tool_call> tags', () => {
  const text = `I will check the weather for you.
<tool_call>
{"name": "get_weather", "arguments": {"location": "Sao Paulo"}}
</tool_call>`;
  const result = extractToolCalls(text);
  assert.equal(result.content, 'I will check the weather for you.');
  assert.equal(result.tool_calls?.length, 1);
  assert.equal(result.tool_calls?.[0]?.function.name, 'get_weather');
  assert.equal(JSON.parse(result.tool_calls?.[0]?.function.arguments || '{}').location, 'Sao Paulo');
});

test('extractToolCalls parses json markdown codeblocks', () => {
  const text = `\`\`\`json
{
  "tool_calls": [
    {
      "name": "read_file",
      "arguments": { "path": "package.json" }
    }
  ]
}
\`\`\``;
  const result = extractToolCalls(text);
  assert.equal(result.content, null);
  assert.equal(result.tool_calls?.length, 1);
  assert.equal(result.tool_calls?.[0]?.function.name, 'read_file');
});

test('extractToolCalls leaves plain text untouched', () => {
  const text = 'Just a standard text response.';
  const result = extractToolCalls(text);
  assert.equal(result.content, text);
  assert.equal(result.tool_calls, undefined);
});
