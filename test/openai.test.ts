import test from 'node:test';
import assert from 'node:assert/strict';
import { completionToResponses, responsesBodyToChat } from '../src/proxy/openai.js';

test('Responses API input converts to chat messages', () => {
  const chat = responsesBodyToChat({ model: 'x', input: 'hello' });
  assert.deepEqual(chat.messages, [{ role: 'user', content: 'hello' }]);
});

test('chat completion converts to basic Responses API envelope', () => {
  const response = completionToResponses({
    id: 'c', object: 'chat.completion', created: 1, model: 'x',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }]
  });
  assert.equal(response.object, 'response');
  assert.equal(response.output_text, 'hello');
});

test('Responses API instructions become a system message', () => {
  const chat = responsesBodyToChat({ instructions: 'be concise', input: 'hello' });
  assert.deepEqual(chat.messages, [
    { role: 'system', content: 'be concise' },
    { role: 'user', content: 'hello' }
  ]);
});
