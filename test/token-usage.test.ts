import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateTokenCount, responsesUsage, withEstimatedUsage } from '../src/proxy/token-usage.js';

test('estimateTokenCount is deterministic and non-zero for text', () => {
  assert.equal(estimateTokenCount(''), 0);
  assert.equal(estimateTokenCount('hello world'), estimateTokenCount('hello world'));
  assert.ok(estimateTokenCount('hello world') > 0);
});

test('withEstimatedUsage replaces zero placeholder usage', () => {
  const completion = withEstimatedUsage({
    id: 'c',
    object: 'chat.completion',
    created: 1,
    model: 'web',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }, {
    messages: [{ role: 'user', content: 'say hello' }]
  });

  assert.equal(completion.usage?.kitt_estimated, true);
  assert.ok(Number(completion.usage?.prompt_tokens) > 0);
  assert.ok(Number(completion.usage?.completion_tokens) > 0);
  assert.equal(
    completion.usage?.total_tokens,
    Number(completion.usage?.prompt_tokens) + Number(completion.usage?.completion_tokens)
  );
});

test('withEstimatedUsage preserves real upstream usage', () => {
  const completion = withEstimatedUsage({
    id: 'c',
    object: 'chat.completion',
    created: 1,
    model: 'web',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
  }, { messages: [{ role: 'user', content: 'hello' }] });

  assert.deepEqual(completion.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
});

test('responsesUsage maps chat usage to Responses API fields', () => {
  const usage = responsesUsage({
    id: 'c',
    object: 'chat.completion',
    created: 1,
    model: 'web',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11, kitt_estimated: true }
  });

  assert.deepEqual(usage, {
    input_tokens: 8,
    output_tokens: 3,
    total_tokens: 11,
    kitt_estimated: true
  });
});
