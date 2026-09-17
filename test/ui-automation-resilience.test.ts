import test from 'node:test';
import assert from 'node:assert/strict';
import { ResilientChatExecutor } from '../src/runtime/resilient-executor.js';
import type { ChatExecutor } from '../src/types.js';

function failingExecutor(errorName: string): ChatExecutor {
  return {
    modelId: 'test-model',
    transport: 'ui',
    async execute() {
      const error = new Error('synthetic failure');
      error.name = errorName;
      throw error;
    },
    describe() {
      return {};
    }
  };
}

test('UI automation failures keep the provider circuit closed', async () => {
  const executor = new ResilientChatExecutor(failingExecutor('UiAutomationError'), 'chatgpt', 1, 30_000);

  await assert.rejects(() => executor.execute({ messages: [] }), /synthetic failure/);

  const snapshot = executor.snapshot();
  assert.equal(snapshot.circuit, 'closed');
  assert.equal(snapshot.failures, 0);
  assert.equal(snapshot.consecutive_failures, 0);
});

test('UI timeouts still count as provider availability failures', async () => {
  const executor = new ResilientChatExecutor(failingExecutor('UiTimeoutError'), 'chatgpt', 1, 30_000);

  await assert.rejects(() => executor.execute({ messages: [] }), /synthetic failure/);

  const snapshot = executor.snapshot();
  assert.equal(snapshot.circuit, 'open');
  assert.equal(snapshot.failures, 1);
  assert.equal(snapshot.consecutive_failures, 1);
});
