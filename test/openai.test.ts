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

test('Responses API propagates stream and max_output_tokens to modern chat fields', () => {
  const chat = responsesBodyToChat({ input: 'hello', stream: true, max_output_tokens: 123 });
  assert.equal(chat.stream, true);
  assert.equal(chat.max_completion_tokens, 123);
});

test('Responses stream uses current output_text event names and closes after response.completed', async () => {
  const { ResponsesStreamWriter } = await import('../src/proxy/openai.js');
  let output = '';
  let endedWith: unknown = '__unset__';
  const fake = {
    status() { return this; },
    setHeader() { return this; },
    flushHeaders() {},
    write(chunk: string) { output += chunk; return true; },
    end(chunk?: unknown) { endedWith = chunk; if (typeof chunk === 'string') output += chunk; return this; }
  };
  const writer = new ResponsesStreamWriter(fake as never, 'web');
  writer.delta('hel');
  writer.finish({
    id: 'c', object: 'chat.completion', created: 1, model: 'web',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }]
  });
  assert.match(output, /event: response\.output_text\.delta/);
  assert.match(output, /event: response\.output_text\.done/);
  assert.match(output, /event: response\.content_part\.done/);
  assert.doesNotMatch(output, /response\.text\.delta/);
  assert.equal(endedWith, undefined);
});
