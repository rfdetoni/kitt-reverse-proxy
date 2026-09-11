import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatExecutionResult, ChatExecutor } from '../src/types.js';
import { ProviderCircuitOpenError, ResilientChatExecutor } from '../src/runtime/resilient-executor.js';

const completion: ChatExecutionResult = {
  completion: {
    id: 'test',
    object: 'chat.completion',
    created: 0,
    model: 'test',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
  },
  deltas: []
};

function failingExecutor(): ChatExecutor {
  return {
    modelId: 'test',
    transport: 'network',
    async execute() {
      const error = new Error('upstream down') as Error & { status: number };
      error.name = 'UpstreamHttpError';
      error.status = 503;
      throw error;
    },
    describe() { return {}; }
  };
}

test('circuit breaker opens after consecutive availability failures and rejects without dispatch', async () => {
  let calls = 0;
  const delegate = failingExecutor();
  const original = delegate.execute.bind(delegate);
  delegate.execute = async (...args) => {
    calls += 1;
    return await original(...args);
  };
  const executor = new ResilientChatExecutor(delegate, 'generic', 2, 10_000);

  await assert.rejects(() => executor.execute({}), /upstream down/);
  await assert.rejects(() => executor.execute({}), /upstream down/);
  await assert.rejects(() => executor.execute({}), ProviderCircuitOpenError);
  assert.equal(calls, 2);
  assert.equal(executor.snapshot().circuit, 'open');
});

test('successful request resets failures and reports latency health', async () => {
  let fail = true;
  const delegate: ChatExecutor = {
    modelId: 'test',
    transport: 'ui',
    async execute() {
      if (fail) {
        fail = false;
        const error = new Error('timeout');
        error.name = 'UiTimeoutError';
        throw error;
      }
      return completion;
    },
    describe() { return {}; }
  };
  const executor = new ResilientChatExecutor(delegate, 'chatgpt', 3, 10_000);
  await assert.rejects(() => executor.execute({}), /timeout/);
  await executor.execute({});
  const snapshot = executor.snapshot();
  assert.equal(snapshot.circuit, 'closed');
  assert.equal(snapshot.consecutive_failures, 0);
  assert.equal(snapshot.successes, 1);
  assert.equal(snapshot.failures, 1);
  assert.equal(typeof snapshot.latency_ewma_ms, 'number');
});
