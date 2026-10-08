import assert from 'node:assert/strict';
import test from 'node:test';
import { KAPError, parseKAP } from '../src/contracts/kap.js';
import { AGENT_CONTRACT_SYSTEM_PROMPT, prepareAgentContractRequest, transformAgentContractCompletion, AgentContractValidationError } from '../src/runtime/agent-contract.js';
import type { OpenAiCompletion } from '../src/types.js';

const plan = () => prepareAgentContractRequest({
  model: 'gemini-web',
  messages: [{ role: 'user', content: 'Inspect the repository' }],
  tools: [{
    type: 'function',
    function: {
      name: 'kitt_runtime',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['repo.read', 'repo.write_file'] },
          arguments: { type: 'object' }
        },
        required: ['operation', 'arguments'],
        additionalProperties: false
      }
    }
  }]
}, { sessionId: 'kap-tests' });

function completion(content: string): OpenAiCompletion {
  return { id: 'test', object: 'chat.completion', created: 1, model: 'gemini-web',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] };
}

test('KAP/1 tool action becomes native validated OpenAI tool call', () => {
  const next = transformAgentContractCompletion(completion([
    'KITT/1',
    'ACTION TOOL',
    'TOOL kitt_runtime',
    'STRING operation = repo.read',
    'OBJECT arguments',
    'STRING arguments.path = README.md',
    'INTEGER arguments.start_line = 1',
    'KITT/END'
  ].join('\n')), plan());
  const call = next.choices[0]!.message.tool_calls![0]!;
  assert.equal(call.function.name, 'kitt_runtime');
  assert.deepEqual(JSON.parse(call.function.arguments), {operation:'repo.read', arguments:{path:'README.md', start_line:1}});
});

test('multiline source is not JSON escaped or reformatted by WebChat parser', () => {
  const source = 'export const greeting = "hello";\n  const pattern = /\\d+/g;\n';
  const next = transformAgentContractCompletion(completion([
    'KITT/1', 'ACTION TOOL', 'TOOL kitt_runtime', 'STRING operation = repo.write_file',
    'OBJECT arguments', 'STRING arguments.path = src/a.ts',
    'TEXT arguments.content', source, 'KITT/ENDTEXT', 'KITT/END'
  ].join('\n')), plan());
  const args = JSON.parse(next.choices[0]!.message.tool_calls![0]!.function.arguments);
  assert.equal(args.arguments.content, source);
});

test('structured final payload converts to JSON produced by trusted code', () => {
  const result = transformAgentContractCompletion(completion([
    'KITT/1', 'ACTION FINAL', 'OBJECT content', 'ARRAY content.items',
    'OBJECT content.items.0', 'STRING content.items.0.local_id = T01',
    'ARRAY content.items.0.check_ids', 'ARRAY content.items.0.paths',
    'KITT/END'
  ].join('\n')), plan());
  assert.deepEqual(JSON.parse(result.choices[0]!.message.content!), {
    items: [{ local_id:'T01', check_ids:[], paths:[] }]
  });
});

test('KAP rejects ambiguous, competing or unsafe actions before tool execution', () => {
  for (const raw of [
    'KITT/1\nACTION FINAL\nSTRING content = done\nKITT/END\nKITT/1\nACTION TOOL\nKITT/END',
    'KITT/1\nACTION FINAL\nSTRING content = yes\nSTRING content = no\nKITT/END',
    'KITT/1\nACTION FINAL\nSTRING content.__proto__.polluted = yes\nKITT/END',
    'KITT/1\nACTION FINAL\nSTRING content = done\nSTRING content.x = hijack\nKITT/END',
    'KITT/1\nACTION FINAL\nARRAY content.items\nSTRING content.items.2 = gap\nKITT/END',
    'KITT/1\nACTION FINAL\nTEXT content\nunterminated\nKITT/END'
  ]) assert.throws(() => parseKAP(raw), KAPError);
});

test('declared tool schema and host policy remain enforced after textual parsing', () => {
  assert.throws(() => transformAgentContractCompletion(completion([
    'KITT/1', 'ACTION TOOL', 'TOOL kitt_runtime',
    'STRING operation = shell.delete_everything',
    'OBJECT arguments', 'KITT/END'
  ].join('\n')), plan()), AgentContractValidationError);
});

test('prompts request textual KAP rather than escaped JSON envelopes', () => {
  assert.match(AGENT_CONTRACT_SYSTEM_PROMPT, /KITT\/1/);
  assert.match(AGENT_CONTRACT_SYSTEM_PROMPT, /TEXT arguments\.content/);
  assert.doesNotMatch(AGENT_CONTRACT_SYSTEM_PROMPT, /Prefer bare JSON|Escape double quotes/);
});
