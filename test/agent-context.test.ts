import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureAgentExecutionContext } from '../src/proxy/openai-router.js';

test('tool-enabled requests receive a leading authoritative external API execution contract', () => {
  const body = ensureAgentExecutionContext({
    model: 'gemini-web',
    messages: [
      { role: 'system', content: 'Answer in one direct, concise sentence. Do not expose reasoning.' },
      { role: 'user', content: 'Create backend and frontend folders and implement the project.' }
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'kitt_runtime',
        parameters: { type: 'object', properties: {} }
      }
    }]
  });

  const messages = body.messages as Array<{ role?: string; content?: string }>;
  const systemMessages = messages.filter((message) => message.role === 'system');

  assert.equal(systemMessages.length, 2);
  assert.match(systemMessages[0]?.content ?? '', /AGENT EXECUTION CONTEXT/);
  assert.match(systemMessages[0]?.content ?? '', /authoritative execution environment/);
  assert.match(systemMessages[0]?.content ?? '', /chat product's own workspace/);
  assert.match(systemMessages[0]?.content ?? '', /unless they are explicitly exposed as callable functions/);
  assert.match(systemMessages[0]?.content ?? '', /Do not ask the user to upload, open, attach, or connect a repository\/workspace/);
  assert.match(systemMessages[0]?.content ?? '', /external tool-call protocol/);
  assert.match(systemMessages[0]?.content ?? '', /Never claim that you cannot create or modify files/);
  assert.match(systemMessages[1]?.content ?? '', /one direct, concise sentence/);
});

test('agent execution context is idempotent across repeated normalization', () => {
  const source = {
    messages: [{ role: 'user', content: 'edit the project' }],
    tools: [{ type: 'function', function: { name: 'edit', parameters: { type: 'object' } } }]
  };
  const once = ensureAgentExecutionContext(source);
  const twice = ensureAgentExecutionContext(once);
  const messages = twice.messages as Array<{ content?: string }>;

  assert.equal(
    messages.filter((message) => message.content?.includes('[AGENT EXECUTION CONTEXT]')).length,
    1
  );
});

test('plain chat and tool_choice none are not promoted to execution-agent mode', () => {
  const plain = {
    messages: [{ role: 'user', content: 'hello' }]
  };
  assert.deepEqual(ensureAgentExecutionContext(plain), plain);

  const disabled = {
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ type: 'function', function: { name: 'noop' } }],
    tool_choice: 'none'
  };
  assert.deepEqual(ensureAgentExecutionContext(disabled), disabled);
});
