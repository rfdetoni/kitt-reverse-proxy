import assert from 'node:assert/strict';
import test from 'node:test';
import type { Server } from 'node:http';
import { startProxyServer } from '../src/proxy/server.js';
import { SessionManager } from '../src/runtime/session-manager.js';
import type { AppConfig, ChatExecutionResult, ChatExecutor } from '../src/types.js';

const completion: ChatExecutionResult = {
  completion: {
    id: 'test',
    object: 'chat.completion',
    created: 0,
    model: 'chatgpt-web',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop'
    }]
  },
  deltas: []
};

function executor(): ChatExecutor {
  return {
    modelId: 'chatgpt-web',
    transport: 'ui',
    async execute() {
      return completion;
    },
    describe() {
      return {};
    }
  };
}

const config = {
  host: '127.0.0.1',
  port: 0,
  maxSessions: 4,
  maxQueue: 8,
  minIntervalMs: 0,
  sessionIdleTimeoutMs: 120_000,
  cors: false,
  transport: 'ui',
  provider: 'chatgpt',
  model: 'chatgpt-web'
} as AppConfig;

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('publishes live session capacity through discovery, capabilities and status', async () => {
  const manager = new SessionManager({
    defaultExecutor: executor(),
    provider: 'chatgpt',
    config,
    factory: async () => ({ executor: executor() })
  });
  await manager.execute('named1', {});

  const server = await startProxyServer({ manager, config });
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const capabilities = await (await fetch(`${baseUrl}/v1/capabilities`)).json() as any;
    const sessionContract = capabilities.kitt_agent_cli.session_management;
    assert.equal(sessionContract.version, 1);
    assert.equal(sessionContract.provider, 'chatgpt');
    assert.equal(sessionContract.header, 'X-Kitt-Session-Id');
    assert.equal(sessionContract.active, 2);
    assert.equal(sessionContract.named, 1);
    assert.equal(sessionContract.max, 4);
    assert.equal(sessionContract.idle_timeout_ms, 120_000);
    assert.equal(sessionContract.eviction, 'lru_idle');
    assert.equal(sessionContract.accepts_named_sessions, true);
    assert.equal(sessionContract.recyclable_idle_named, 1);

    const discovery = await (await fetch(`${baseUrl}/v1`)).json() as any;
    assert.deepEqual(
      discovery.capabilities.kitt_agent_cli.session_management,
      sessionContract
    );

    const status = await (await fetch(`${baseUrl}/v1/kitt/status`)).json() as any;
    assert.deepEqual(status.session_capacity, manager.capacity());

    const sessions = await (await fetch(`${baseUrl}/v1/kitt/sessions`)).json() as any;
    assert.equal(sessions.sessions.length, 2);
    assert.deepEqual(sessions.capacity, manager.capacity());
  } finally {
    await closeServer(server);
    await manager.close();
  }
});
