import test from 'node:test';
import assert from 'node:assert/strict';
import { completionToResponses, responsesBodyToChat, sendChatStream, sendResponsesStream } from '../src/proxy/openai.js';

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

test('sendChatStream outputs progressive SSE chunks with deltas', () => {
  const written: string[] = [];
  const fakeRes = {
    status: () => fakeRes,
    setHeader: () => fakeRes,
    write: (chunk: string) => { written.push(chunk); return true; },
    end: (chunk?: string) => { if (chunk) written.push(chunk); }
  };

  const completion = {
    id: 'chatcmpl-test',
    object: 'chat.completion' as const,
    created: 123456,
    model: 'gpt-test',
    choices: [{ index: 0, message: { role: 'assistant' as const, content: 'Hello world' }, finish_reason: 'stop' }]
  };

  sendChatStream(fakeRes as never, completion, ['Hello', ' world']);
  assert.ok(written.some((w) => w.includes('"content":"Hello"')));
  assert.ok(written.some((w) => w.includes('"content":" world"')));
  assert.ok(written.some((w) => w.includes('[DONE]')));
});

test('sendResponsesStream outputs response stream events', () => {
  const written: string[] = [];
  const fakeRes = {
    status: () => fakeRes,
    setHeader: () => fakeRes,
    write: (chunk: string) => { written.push(chunk); return true; },
    end: (chunk?: string) => { if (chunk) written.push(chunk); }
  };

  const completion = {
    id: 'chatcmpl-test',
    object: 'chat.completion' as const,
    created: 123456,
    model: 'gpt-test',
    choices: [{ index: 0, message: { role: 'assistant' as const, content: 'Hello world' }, finish_reason: 'stop' }]
  };

  sendResponsesStream(fakeRes as never, completion, ['Hello', ' world']);
  assert.ok(written.some((w) => w.includes('response.created')));
  assert.ok(written.some((w) => w.includes('response.text.delta')));
  assert.ok(written.some((w) => w.includes('response.completed')));
  assert.ok(written.some((w) => w.includes('[DONE]')));
});
