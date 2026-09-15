import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatStreamWriter,
  completionToResponses,
  openAiErrorType,
  responsesBodyToChat,
  sendOpenAiError
} from '../src/proxy/openai.js';

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

test('Responses API carries estimated usage into its native usage fields', () => {
  const response = completionToResponses({
    id: 'c', object: 'chat.completion', created: 1, model: 'x',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9, kitt_estimated: true }
  });
  assert.deepEqual(response.usage, {
    input_tokens: 7,
    output_tokens: 2,
    total_tokens: 9,
    kitt_estimated: true
  });
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

test('Responses input function_call_output becomes tool message', () => {
  const chat = responsesBodyToChat({
    input: [{ type: 'function_call_output', call_id: 'call_weather', output: '{"temp":18}' }]
  });
  assert.deepEqual(chat.messages, [{
    role: 'tool',
    tool_call_id: 'call_weather',
    content: '{"temp":18}'
  }]);
});

test('Responses completion preserves function_call item', () => {
  const response = completionToResponses({
    id: 'c', object: 'chat.completion', created: 1, model: 'web',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_abc',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }]
  });
  const output = response.output as any[];
  assert.equal(output[0].type, 'function_call');
  assert.equal(output[0].call_id, 'call_abc');
  assert.equal(output[0].name, 'read_file');
});

test('Responses stream emits function argument events', async () => {
  const { ResponsesStreamWriter } = await import('../src/proxy/openai.js');
  let output = '';
  const fake = {
    status() { return this; },
    setHeader() { return this; },
    flushHeaders() {},
    write(chunk: string) { output += chunk; return true; },
    end() { return this; }
  };
  const writer = new ResponsesStreamWriter(fake as never, 'web');
  writer.finish({
    id: 'c', object: 'chat.completion', created: 1, model: 'web',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_abc', type: 'function',
          function: { name: 'read_file', arguments: '{"path":"README.md"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }]
  });
  assert.match(output, /response\.function_call_arguments\.delta/);
  assert.match(output, /response\.function_call_arguments\.done/);
  assert.match(output, /"type":"function_call"/);
});

test('OpenAI errors always use a structured SDK-compatible envelope', () => {
  let status = 0;
  let payload: any;
  const fake = {
    status(value: number) { status = value; return this; },
    json(value: unknown) { payload = value; return this; }
  };
  sendOpenAiError(fake as never, 429, 'queue full', 'session_limit_exceeded');
  assert.equal(status, 429);
  assert.deepEqual(payload, {
    error: {
      message: 'queue full',
      type: 'rate_limit_error',
      param: null,
      code: 'session_limit_exceeded'
    }
  });
  assert.equal(openAiErrorType(400), 'invalid_request_error');
  assert.equal(openAiErrorType(401), 'authentication_error');
  assert.equal(openAiErrorType(503), 'api_error');
});

test('Chat stream emits SSE keepalive while a started stream is idle', async () => {
  let output = '';
  const fake = {
    writableEnded: false,
    destroyed: false,
    status() { return this; },
    setHeader() { return this; },
    flushHeaders() {},
    write(chunk: string) { output += chunk; return true; },
    end(chunk?: unknown) {
      this.writableEnded = true;
      if (typeof chunk === 'string') output += chunk;
      return this;
    }
  };
  const writer = new ChatStreamWriter(fake as never, 'web', 5);
  writer.delta('a');
  await new Promise((resolve) => setTimeout(resolve, 18));
  writer.finish({
    id: 'c', object: 'chat.completion', created: 1, model: 'web',
    choices: [{ index: 0, message: { role: 'assistant', content: 'a' }, finish_reason: 'stop' }]
  });
  assert.match(output, /: ping\n\n/);
});
