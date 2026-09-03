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

test('injectToolsIntoPrompt includes API directive and system context', () => {
  const prompt = injectToolsIntoPrompt('List files', {
    systemPrompt: 'You are a CLI agent.',
    tools: [{ type: 'function', function: { name: 'ls' } }]
  });
  assert.match(prompt, /SYSTEM DIRECTIVE/);
  assert.match(prompt, /You are a CLI agent\./);
  assert.match(prompt, /"name":"ls"/);
  assert.match(prompt, /List files/);
});
test('plain request without tools/system gets no injected directive', () => {
  assert.equal(injectToolsIntoPrompt('hello'), 'hello');
});

test('unknown function is rejected as invalid model protocol', async () => {
  const { buildToolProtocolPlan, ToolProtocolError } = await import('../src/mapping/tool-calling.js');
  const plan = buildToolProtocolPlan({
    messages: [],
    tools: [{ type: 'function', function: { name: 'weather' } }]
  });
  assert.throws(() => extractToolCalls(
    '<tool_call>{"name":"shell","arguments":{}}</tool_call>',
    plan
  ), ToolProtocolError);
});

test('tool_choice none leaves tool-looking text as normal content', async () => {
  const { buildToolProtocolPlan } = await import('../src/mapping/tool-calling.js');
  const plan = buildToolProtocolPlan({
    messages: [],
    tools: [{ type: 'function', function: { name: 'weather' } }],
    tool_choice: 'none'
  });
  const text = '<tool_call>{"name":"weather","arguments":{}}</tool_call>';
  assert.deepEqual(extractToolCalls(text, plan), { content: text });
});

test('parallel_tool_calls=false rejects multiple calls', async () => {
  const { buildToolProtocolPlan, ToolProtocolError } = await import('../src/mapping/tool-calling.js');
  const plan = buildToolProtocolPlan({
    messages: [],
    tools: [
      { type: 'function', function: { name: 'a' } },
      { type: 'function', function: { name: 'b' } }
    ],
    parallel_tool_calls: false
  });
  assert.throws(() => extractToolCalls(
    '```json\n{"tool_calls":[{"name":"a","arguments":{}},{"name":"b","arguments":{}}]}\n```',
    plan
  ), ToolProtocolError);
});


test('invalid tool request shapes fail closed', async () => {
  const { buildToolProtocolPlan, ToolProtocolError } = await import('../src/mapping/tool-calling.js');
  assert.throws(() => buildToolProtocolPlan({ messages: [], tools: 'bad' as any }), ToolProtocolError);
  assert.throws(() => buildToolProtocolPlan({
    messages: [],
    tools: [{ type: 'function', function: { name: 'x', parameters: [] } }]
  }), ToolProtocolError);
  assert.throws(() => buildToolProtocolPlan({
    messages: [],
    tools: [{ type: 'function', function: { name: 'x' } }],
    parallel_tool_calls: 'false' as any
  }), ToolProtocolError);
});

test('required and forced tool choices are enforced', async () => {
  const { assertToolChoiceSatisfied, buildToolProtocolPlan, ToolProtocolError } = await import('../src/mapping/tool-calling.js');
  const required = buildToolProtocolPlan({
    messages: [],
    tools: [{ type: 'function', function: { name: 'weather' } }],
    tool_choice: 'required'
  });
  assert.throws(() => assertToolChoiceSatisfied(required, undefined), ToolProtocolError);

  const forced = buildToolProtocolPlan({
    messages: [],
    tools: [{ type: 'function', function: { name: 'weather' } }],
    tool_choice: { type: 'function', function: { name: 'weather' } }
  });
  assert.throws(() => assertToolChoiceSatisfied(forced, [{
    id: 'call_1', type: 'function', function: { name: 'other', arguments: '{}' }
  }] as any), ToolProtocolError);
});
