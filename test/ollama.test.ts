import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completionToOllamaChat,
  completionToOllamaGenerate,
  ollamaGenerateBodyToChat,
  ollamaTagsResponse,
  validateOllamaChatBody,
  OllamaChatStreamWriter,
  OllamaGenerateStreamWriter
} from '../src/proxy/ollama.js';

test('validateOllamaChatBody requires valid messages', () => {
  assert.throws(() => validateOllamaChatBody({}), /"messages"/);
  assert.throws(() => validateOllamaChatBody({ messages: [] }), /"messages"/);
  assert.deepEqual(validateOllamaChatBody({ messages: [{ role: 'user', content: 'hi' }] }), {
    messages: [{ role: 'user', content: 'hi' }]
  });
});

test('ollamaGenerateBodyToChat converts prompt to user message', () => {
  const chat = ollamaGenerateBodyToChat({ prompt: 'olá', system: 'você é o kitt' });
  assert.deepEqual(chat.messages, [
    { role: 'system', content: 'você é o kitt' },
    { role: 'user', content: 'olá' }
  ]);
});

test('completionToOllamaChat formats non-streaming response', () => {
  const result = completionToOllamaChat({
    id: 'c',
    object: 'chat.completion',
    created: 1,
    model: 'chatgpt-web',
    choices: [{ index: 0, message: { role: 'assistant', content: 'tudo bem' }, finish_reason: 'stop' }]
  }, 'chatgpt-web');

  assert.equal(result.model, 'chatgpt-web');
  assert.equal((result.message as { content: string }).content, 'tudo bem');
  assert.equal(result.done, true);
});

test('completionToOllamaGenerate formats generate response', () => {
  const result = completionToOllamaGenerate({
    id: 'c',
    object: 'chat.completion',
    created: 1,
    model: 'claude-web',
    choices: [{ index: 0, message: { role: 'assistant', content: 'resposta gerada' }, finish_reason: 'stop' }]
  }, 'claude-web');

  assert.equal(result.model, 'claude-web');
  assert.equal(result.response, 'resposta gerada');
  assert.equal(result.done, true);
});

test('ollamaTagsResponse provides model listing', () => {
  const tags = ollamaTagsResponse('gemini-web');
  assert.equal(Array.isArray(tags.models), true);
  assert.equal((tags.models as Array<{ name: string }>)[0]?.name, 'gemini-web');
});

test('Ollama stream writers emit valid NDJSON chunks', () => {
  let output = '';
  const fake = {
    status() { return this; },
    setHeader() { return this; },
    flushHeaders() {},
    write(chunk: string) { output += chunk; return true; },
    end() { return this; }
  };
  const writer = new OllamaChatStreamWriter(fake as never, 'chatgpt-web');
  writer.delta('oi');
  writer.finish();

  const lines = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].message.content, 'oi');
  assert.equal(lines[0].done, false);
  assert.equal(lines[1].done, true);
});
test('completionToOllamaChat preserves tool_calls', () => {
  const result = completionToOllamaChat({
    id: 'c',
    object: 'chat.completion',
    created: 1,
    model: 'chatgpt-web',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'weather', arguments: '{"city":"Paris"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }]
  }, 'chatgpt-web');
  const calls = (result.message as any).tool_calls;
  assert.equal(calls[0].function.name, 'weather');
  assert.deepEqual(calls[0].function.arguments, { city: 'Paris' });
});
