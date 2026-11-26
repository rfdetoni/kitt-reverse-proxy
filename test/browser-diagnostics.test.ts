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
    context: { newPage: async () => { throw new Error('provider context must not be reused'); } },
    browser: {
      isConnected: () => true,
      newContext: async () => ({ newPage: async () => page, close: async () => undefined })
    }
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


test('browser upload only accepts bounded inline bytes, never host filenames', async () => {
  let uploaded: unknown;
  const page = {
    url: () => 'https://example.org/',
    isClosed: () => false,
    locator: () => ({
      first: () => ({
        setInputFiles: async (payload: unknown) => { uploaded = payload; }
      })
    })
  };
  const context = { close: async () => undefined };
  const enabled = new BrowserAutomationSession(page as never, context as never, undefined, true);
  const disabled = new BrowserAutomationSession(page as never, context as never);
  const args = { selector: '#file', filename: 'sample.txt', data_base64: 'YWJj' };
  await assert.rejects(disabled.execute('upload', args, ['https://example.org']), /disabled/);
  await assert.rejects(enabled.execute('upload', { ...args, filename: '../secret.txt' }, ['https://example.org']), /basename/);
  await assert.rejects(enabled.execute('upload', { ...args, data_base64: '!' }, ['https://example.org']), /payload/);
  const result = await enabled.execute('upload', args, ['https://example.org']);
  assert.equal(result.bytes, 3);
  assert.deepEqual(uploaded, { name: 'sample.txt', mimeType: 'application/octet-stream', buffer: Buffer.from('abc') });
  await assert.rejects(enabled.execute('download', {url: 'https://other.org/file'}, ['https://example.org', 'https://other.org']), /current page origin/);
});
