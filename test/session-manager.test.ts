import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLimitExceededError, SessionManager } from '../src/runtime/session-manager.js';
import type { AppConfig, ChatExecutor, JsonObject } from '../src/types.js';

const config = {
  targetUrl: 'https://chatgpt.com/',
  model: '',
  ollamaUrl: 'http://127.0.0.1:11434/api/generate',
  host: '127.0.0.1',
  port: 3000,
  captureTimeoutMs: 1000,
  settleAfterCandidateMs: 100,
  responseSampleTimeoutMs: 1000,
  ollamaTimeoutMs: 1000,
  upstreamTimeoutMs: 1000,
  uiResponseTimeoutMs: 1000,
  uiSettleMs: 100,
  manualInterventionTimeoutMs: 1000,
  maxSessions: 2,
  sessionIdleTimeoutMs: 100,
  logFormat: 'text',
  headed: false,
  cors: false,
  maxQueue: 4,
  minIntervalMs: 0,
  allowedEndpointHosts: [],
  followRedirects: false,
  provider: 'chatgpt',
  transport: 'ui'
} satisfies AppConfig;

function executor(name: string): ChatExecutor {
  return {
    modelId: name,
    transport: 'ui',
    async execute(_body: JsonObject) {
      return {
        completion: {
          id: 'x',
          object: 'chat.completion',
          created: 1,
          model: name,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
        },
        deltas: []
      };
    },
    describe() { return {}; }
  };
}

test('session manager creates isolated named sessions and enforces max', async () => {
  const manager = new SessionManager({
    defaultExecutor: executor('default'),
    provider: 'chatgpt',
    config,
    factory: async (id) => ({ executor: executor(id) })
  });
  try {
    await manager.execute('A1', { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(manager.list().length, 2);
    await assert.rejects(
      () => manager.execute('B2', { messages: [{ role: 'user', content: 'x' }] }),
      SessionLimitExceededError
    );
  } finally {
    await manager.close();
  }
});
