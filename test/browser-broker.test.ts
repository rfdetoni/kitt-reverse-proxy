import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSessionBroker } from '../src/runtime/browser-broker.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';
import type { ProviderPreset } from '../src/providers/catalog.js';

test('browser broker reuses authenticated persistent context while isolating tabs', async () => {
  let closed = 0;
  let navigated = '';
  const page = {
    async goto(url: string) { navigated = url; },
    async close() { closed += 1; }
  };
  const context = {
    async newPage() { return page; }
  };
  const base = {
    context,
    page: {},
    persistent: true,
    headed: false,
    async close() {}
  } as unknown as LiveBrowserSession;
  const config = {
    targetUrl: 'https://chatgpt.com/',
    manualInterventionTimeoutMs: 1_000,
    headed: false
  } as AppConfig;
  const provider = {
    ui: { newChatUrl: 'https://chatgpt.com/' }
  } as unknown as ProviderPreset;

  const broker = new BrowserSessionBroker(base, config);
  const lease = await broker.acquire(provider);
  assert.equal(lease.context, context);
  assert.equal(navigated, 'https://chatgpt.com/');
  assert.equal(broker.snapshot().active_leases, 1);
  assert.equal(broker.snapshot().authenticated_context_reused, true);

  await lease.close();
  await lease.close();
  assert.equal(closed, 1);
  assert.equal(broker.snapshot().active_leases, 0);
});
