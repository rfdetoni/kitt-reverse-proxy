import assert from 'node:assert/strict';
import test from 'node:test';

import {
  anthropicBodyToChat,
  completionToAnthropic
} from '../src/proxy/anthropic.js';

test('Anthropic system/user maps to canonical chat', () => {
  const body = anthropicBodyToChat({
    model: 'claude-web',
    max_tokens: 1024,
    system: 'Be useful.',
    messages: [{ role: 'user', content: 'hello' }]
  });
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'Be useful.' },
    { role: 'user', content: 'hello' }
  ]);
});

test('Anthropic tools and forced tool choice map to OpenAI tools', () => {
  const body = anthropicBodyToChat({
    model: 'claude-web',
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [{
      name: 'get_weather',
      description: 'weather',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' } }
      }
    }],
    tool_choice: { type: 'tool', name: 'get_weather' }
  });
  assert.equal((body.tools as any[])[0].function.name, 'get_weather');
  assert.equal((body.tool_choice as any).function.name, 'get_weather');
});

test('tool_result maps to role tool with original call id', () => {
  const body = anthropicBodyToChat({
    model: 'claude-web',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_123',
        content: '{"temperature":23}'
      }]
    }]
  });
  assert.deepEqual(body.messages, [{
    role: 'tool',
    tool_call_id: 'toolu_123',
    content: '{"temperature":23}'
  }]);
});

test('OpenAI tool call maps to Anthropic tool_use', () => {
  const result = completionToAnthropic({
    id: 'c',
    object: 'chat.completion',
    created: 1,
    model: 'claude-web',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'toolu_123',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"path":"README.md"}'
          }
        }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
  });
  assert.equal(result.stop_reason, 'tool_use');
  assert.equal((result.content as any[])[0].type, 'tool_use');
  assert.equal((result.content as any[])[0].name, 'read_file');
});
