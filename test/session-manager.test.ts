import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionLimitExceededError, SessionManager } from '../src/runtime/session-manager.js';
import type { AppConfig, ChatExecutor, JsonObject, LiveBrowserSession } from '../src/types.js';

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

test('session manager evicts an idle named session when capacity is reached', async () => {
  const manager = new SessionManager({
    defaultExecutor: executor('default'),
    provider: 'chatgpt',
    config,
    factory: async (id) => ({ executor: executor(id) })
  });
  try {
    await manager.execute('A1', { messages: [{ role: 'user', content: 'x' }] });
    assert.deepEqual(manager.list().map((session) => session.id), ['default', 'A1']);

    await manager.execute('B2', { messages: [{ role: 'user', content: 'x' }] });
    assert.deepEqual(manager.list().map((session) => session.id), ['default', 'B2']);
  } finally {
    await manager.close();
  }
});

test('named child sessions reuse their lease while sibling sessions stay isolated', async () => {
  const created: string[] = [];
  const closed: string[] = [];
  const childConfig = { ...config, maxSessions: 3 };
  const manager = new SessionManager({
    defaultExecutor: executor('default'),
    provider: 'chatgpt',
    config: childConfig,
    factory: async (id) => {
      created.push(id);
      const browserSession = {
        context: {} as any,
        page: {} as any,
        persistent: true,
        async close() { closed.push(id); }
      } as LiveBrowserSession;
      return { executor: executor(id), browserSession };
    }
  });
  try {
    await manager.execute('childa', { messages: [{ role: 'user', content: 'one' }] });
    await manager.execute('childa', { messages: [{ role: 'user', content: 'two' }] });
    await manager.execute('childb', { messages: [{ role: 'user', content: 'other' }] });

    assert.deepEqual(created, ['childa', 'childb']);
    assert.deepEqual(
      manager.list().map((session) => session.id),
      ['default', 'childa', 'childb']
    );
  } finally {
    await manager.close();
  }

  assert.deepEqual(closed.sort(), ['childa', 'childb']);
});

test('concurrent creation reserves capacity before awaiting browser startup', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let creations = 0;
  const manager = new SessionManager({
    defaultExecutor: executor('default'), provider: 'chatgpt', config,
    factory: async (id) => { creations += 1; await ready; return { executor: executor(id) }; }
  });
  const first = manager.execute('A1', { messages: [{ role: 'user', content: 'first' }] });
  try {
    await assert.rejects(manager.execute('B2', { messages: [{ role: 'user', content: 'second' }] }), SessionLimitExceededError);
    assert.equal(creations, 1);
  } finally {
    release();
    await first;
    await manager.close();
  }
});


test('session manager attaches per-request timing metadata', async () => {
  const manager = new SessionManager({
    defaultExecutor: executor('default'),
    provider: 'chatgpt',
    config
  });
  try {
    const result = await manager.execute(undefined, { messages: [{ role: 'user', content: 'timing' }] });
    const timing = result.metadata?.timing as JsonObject | undefined;
    assert.ok(timing);
    assert.equal(timing.transport, 'ui');
    for (const key of ['session_resolve_ms', 'queue_wait_ms', 'executor_ms', 'total_ms']) {
      assert.equal(typeof timing[key], 'number');
      assert.ok((timing[key] as number) >= 0);
    }
  } finally {
    await manager.close();
  }
});


test('browser automation uses a separate tab and never navigates the provider chat page', async () => {
  let providerNavigations = 0;
  let automationNavigations = 0;
  let automationClosed = 0;
  let createdPages = 0;

  const automationPage = {
    isClosed: () => false,
    async goto() { automationNavigations += 1; },
    url: () => 'http://127.0.0.1:4200/',
    async title() { return 'App'; },
    async close() { automationClosed += 1; },
    async route() {},
    on() {},
    mainFrame() { return {}; },
    locator() { throw new Error('not used'); }
  } as any;

  const browserSession: LiveBrowserSession = {
    context: {
      async newPage() {
        createdPages += 1;
        return automationPage;
      }
    } as any,
    page: {
      async goto() { providerNavigations += 1; }
    } as any,
    persistent: true,
    async close() {}
  };

  const manager = new SessionManager({
    defaultExecutor: executor('default'),
    defaultBrowserSession: browserSession,
    provider: 'chatgpt',
    config
  });
  try {
    assert.equal(manager.browserAutomationSupported(), true);
    const opened = await manager.browserAction(undefined, 'open', {
      url: 'http://127.0.0.1:4200/'
    });
    assert.equal(opened.action, 'open');
    assert.equal(opened.session_id, 'default');
    assert.equal(createdPages, 1);
    assert.equal(automationNavigations, 1);
    assert.equal(providerNavigations, 0);

    const closed = await manager.browserAction(undefined, 'close', {});
    assert.equal(closed.closed, true);
    assert.equal(automationClosed, 1);
  } finally {
    await manager.close();
  }
});
