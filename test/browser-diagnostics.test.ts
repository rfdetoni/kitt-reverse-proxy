import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { BrowserAutomationSession } from '../src/runtime/browser-automation.js';
import type { LiveBrowserSession } from '../src/types.js';

test('browser diagnostics capture bounded real events without raw secrets', async () => {
  const page = new EventEmitter() as EventEmitter & {
    route: (mask: string, callback: (...args: never[]) => Promise<void>) => Promise<void>;
    close: () => Promise<void>;
    isClosed: () => boolean;
    url: () => string;
  };
  page.route = async () => undefined;
  page.close = async () => undefined;
  page.isClosed = () => false;
  page.url = () => 'https://example.org/';
  const base = {
    context: { newPage: async () => page }
  } as unknown as LiveBrowserSession;
  const session = await BrowserAutomationSession.create(base, ['https://example.org']);
  page.emit('console', { type: () => 'error', text: () => 'Bearer TOP_SECRET_123' });
  page.emit('pageerror', new Error('API secret exposed'));
  page.emit('requestfailed', {
    url: () => 'https://example.org/api?token=secret',
    failure: () => ({ errorText: 'connection refused, key=secret' }),
    resourceType: () => 'fetch',
  });
  page.emit('response', {
    status: () => 500,
    url: () => 'https://example.org/api?token=secret',
    request: () => ({ resourceType: () => 'xhr' }),
  });
  const snapshot = await session.execute('diagnose', {}, ['https://example.org']);
  assert.deepEqual(snapshot.counters, {
    console: 1, pageerror: 1, requestfailed: 1, http_error: 1
  });
  const visible = JSON.stringify(snapshot);
  assert.doesNotMatch(visible, /TOP_SECRET|Bearer|connection refused|token=secret|API secret exposed/);
  assert.match(visible, /"fingerprint"/);
  assert.match(visible, /"status":500/);
});
