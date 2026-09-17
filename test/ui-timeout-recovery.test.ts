import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ChatExecutionOptions,
  ChatExecutionResult,
  ChatExecutor,
  JsonObject
} from '../src/types.js';
import { ResilientChatExecutor } from '../src/runtime/resilient-executor.js';

function success(): ChatExecutionResult {
  return {
    completion: {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'gemini-web',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop'
      }]
    },
    deltas: ['ok']
  };
}

class FakeUiExecutor implements ChatExecutor {
  readonly modelId = 'gemini-web';
  readonly transport = 'ui' as const;
  calls = 0;
  resets = 0;

  constructor(private readonly fail = true) {}

  async execute(_body: JsonObject, _options?: ChatExecutionOptions): Promise<ChatExecutionResult> {
    this.calls += 1;
    if (this.fail) {
      const error = new Error('stalled UI');
      error.name = 'UiTimeoutError';
      throw error;
    }
    return success();
  }

  async reset(): Promise<void> {
    this.resets += 1;
  }

  describe(): JsonObject {
    return {};
  }
}

test('UI timeout is propagated without opening a new conversation or retrying', async () => {
  const delegate = new FakeUiExecutor();
  const executor = new ResilientChatExecutor(delegate, 'gemini');

  await assert.rejects(
    () => executor.execute({ messages: [{ role: 'user', content: 'implement' }] }),
    (error: unknown) => error instanceof Error && error.name === 'UiTimeoutError'
  );

  assert.equal(delegate.calls, 1);
  assert.equal(delegate.resets, 0);
  assert.equal(executor.snapshot().failures, 1);
  assert.equal(executor.snapshot().successes, 0);
});

test('explicit reset remains available without being used for automatic recovery', async () => {
  const delegate = new FakeUiExecutor(false);
  const executor = new ResilientChatExecutor(delegate, 'gemini');

  const result = await executor.execute({ messages: [{ role: 'user', content: 'implement' }] });

  assert.equal(result.completion.choices[0]?.message.content, 'ok');
  assert.equal(delegate.calls, 1);
  assert.equal(delegate.resets, 0);
  assert.equal(executor.snapshot().failures, 0);
  assert.equal(executor.snapshot().successes, 1);

  assert.ok(executor.reset);
  await executor.reset!();
  assert.equal(delegate.resets, 1);
});
