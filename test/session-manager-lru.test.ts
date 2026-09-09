import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AppConfig,
  ChatExecutionResult,
  ChatExecutor,
  JsonObject,
  LiveBrowserSession
} from '../src/types.js';
import {
  SessionLimitExceededError,
  SessionManager
} from '../src/runtime/session-manager.js';

const completion: ChatExecutionResult = {
  completion: {
    id: 'test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop'
      }
    ]
  },
  deltas: []
};

function config(maxSessions: number): AppConfig {
  return {
    maxSessions,
    maxQueue: 8,
    minIntervalMs: 0,
    sessionIdleTimeoutMs: 60_000
  } as AppConfig;
}

function executor(run?: (body: JsonObject) => Promise<void>): ChatExecutor {
  return {
    modelId: 'test-model',
    transport: 'ui',
    async execute(body) {
      await run?.(body);
      return completion;
    },
    describe() {
      return {};
    }
  };
}

function browserSession(id: string, closed: string[]): LiveBrowserSession {
  return {
    async close() {
      closed.push(id);
    }
  } as LiveBrowserSession;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test('evicts the least-recently-used idle named session at capacity', async () => {
  const closed: string[] = [];
  const manager = new SessionManager({
    defaultExecutor: executor(),
    provider: 'chatgpt',
    config: config(3),
    factory: async (id) => ({
      executor: executor(),
      browserSession: browserSession(id, closed)
    })
  });

  try {
    await manager.execute('a', {});
    await tick();
    await manager.execute('b', {});
    await tick();
    await manager.execute('a', {});
    await tick();

    await manager.execute('c', {});

    assert.deepEqual(
      manager.list().map((session) => session.id).sort(),
      ['a', 'c', 'default']
    );
    assert.deepEqual(closed, ['b']);
  } finally {
    await manager.close();
  }
});

test('never evicts a busy session to admit a new one', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });

  const manager = new SessionManager({
    defaultExecutor: executor(),
    provider: 'chatgpt',
    config: config(2),
    factory: async (id) => ({
      executor: executor(id === 'a' ? async () => blocked : undefined)
    })
  });

  const running = manager.execute('a', {});
  await new Promise<void>((resolve) => setImmediate(resolve));

  await assert.rejects(
    manager.execute('b', {}),
    SessionLimitExceededError
  );
  assert.deepEqual(manager.list().map((session) => session.id).sort(), ['a', 'default']);

  release();
  await running;
  await manager.close();
});
