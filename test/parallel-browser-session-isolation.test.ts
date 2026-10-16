import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSessionBroker } from '../src/runtime/browser-broker.js';
import { SessionManager } from '../src/runtime/session-manager.js';
import type { AppConfig, ChatExecutor, JsonObject, LiveBrowserSession } from '../src/types.js';
import type { ProviderPreset } from '../src/providers/catalog.js';

const config = {
  targetUrl: 'https://chatgpt.com/',
  maxSessions: 4,
  maxBrowserPages: 12,
  maxResidentRssBytes: 16 * 1024 * 1024 * 1024,
  maxQueue: 8,
  minIntervalMs: 0,
  sessionIdleTimeoutMs: 600_000,
  manualInterventionTimeoutMs: 2000,
  headed: true
} as AppConfig;

const provider = {
  ui: { newChatUrl: 'https://chatgpt.com/' }
} as ProviderPreset;

test('concurrent retained children receive unique browser tabs in one authenticated context', async () => {
  const pages: Array<{ readonly index: number; url: string | undefined; closed: boolean; goto(url: string): Promise<void>; close(): Promise<void>; isClosed(): boolean }> = [];
  const context = {
    async newPage() {
      const page = {
        index: pages.length,
        url: undefined as string | undefined,
        closed: false,
        async goto(url: string) { this.url = url; },
        async close() { this.closed = true; },
        isClosed() { return this.closed; }
      };
      pages.push(page);
      return page;
    },
    pages: () => pages
  };
  const base = {
    context,
    page: await context.newPage(),
    persistent: true,
    headed: true,
    async close() { /* The default browser page is not owned by a child. */ }
  } as unknown as LiveBrowserSession;
  const broker = new BrowserSessionBroker(base, config);
  const sessions = new Map<string, LiveBrowserSession>();
  let running = 0;
  let peakConcurrent = 0;
  const chatExecutor = (id: string): ChatExecutor => ({
    modelId: id,
    transport: 'ui',
    async execute(_body: JsonObject) {
      peakConcurrent = Math.max(peakConcurrent, ++running);
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      running -= 1;
      return {
        completion: {
          id,
          object: 'chat.completion',
          created: 1,
          model: id,
          choices: [{ index: 0, message: { role: 'assistant', content: id }, finish_reason: 'stop' }]
        },
        deltas: []
      };
    },
    describe() { return {}; }
  });
  const manager = new SessionManager({
    defaultExecutor: chatExecutor('default'),
    defaultBrowserSession: base,
    provider: 'chatgpt',
    config,
    factory: async (id) => {
      const session = await broker.acquire(provider);
      sessions.set(id, session);
      return { executor: chatExecutor(id), browserSession: session };
    }
  });

  try {
    const [first, second] = await Promise.all([
      manager.execute('childa', { messages: [{ role: 'user', content: 'task a' }] }),
      manager.execute('childb', { messages: [{ role: 'user', content: 'task b' }] })
    ]);
    assert.equal(first.completion.choices[0]?.message.content, 'childa');
    assert.equal(second.completion.choices[0]?.message.content, 'childb');
    assert.equal(peakConcurrent, 2, 'sibling session queues must execute concurrently');
    assert.equal(sessions.size, 2);
    assert.notEqual(sessions.get('childa')?.page, sessions.get('childb')?.page);
    assert.notEqual(sessions.get('childa')?.page, base.page);
    assert.notEqual(sessions.get('childb')?.page, base.page);
    assert.equal(sessions.get('childa')?.context, base.context);
    assert.equal(sessions.get('childb')?.context, base.context);
    assert.equal(pages.length, 3, 'one default page and one browser tab per child');
    assert.equal(broker.snapshot().active_leases, 2);
    assert.deepEqual(manager.list().map(({id}) => id), ['default', 'childa', 'childb']);

    const original = sessions.get('childa')?.page;
    const again = await manager.execute('childa', {
      messages: [{ role: 'user', content: 'child a follow-up' }]
    });
    assert.equal(again.completion.choices[0]?.message.content, 'childa');
    assert.equal(sessions.get('childa')?.page, original, 'same retained child reuses its tab');
    assert.equal(pages.length, 3);
  } finally {
    await manager.close();
  }
  assert.equal(broker.snapshot().active_leases, 0);
  assert.deepEqual(pages.map(page => page.closed), [false, true, true]);
});

test('distinct child sessions do not silently collapse onto the default proxy queue', async () => {
  let running = 0;
  let peak = 0;
  const simpleExecutor = (name: string): ChatExecutor => ({
    modelId: name,
    transport: 'ui',
    async execute() {
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, 30));
      running -= 1;
      return { completion: {
        id: name, object: 'chat.completion', created: 1, model: name,
        choices: [{ index: 0, message: { role: 'assistant', content: name }, finish_reason: 'stop' }]
      }, deltas: [] };
    },
    describe() { return {}; }
  });
  const manager = new SessionManager({
    defaultExecutor: simpleExecutor('default'),
    provider: 'chatgpt',
    config,
    factory: async (id) => ({ executor: simpleExecutor(id) })
  });
  try {
    await Promise.all([
      manager.execute('retainedChildA', { messages: [{ role: 'user', content: 'A' }] }),
      manager.execute('retainedChildB', { messages: [{ role: 'user', content: 'B' }] })
    ]);
    assert.equal(peak, 2);
    assert.equal(manager.capacity().named, 2);
  } finally { await manager.close(); }
});
