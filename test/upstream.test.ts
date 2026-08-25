import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserUpstreamClient } from '../src/runtime/upstream.js';

test('browser upstream uses context request, blocks redirects and rotates matching headers', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeContext = {
    request: {
      async fetch(_url: string, options: Record<string, unknown>) {
        calls.push(options);
        return {
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json', 'x-csrf-token': calls.length === 1 ? 'new-token' : 'newer-token' }),
          text: async () => JSON.stringify({ answer: 'ok' }),
          dispose: async () => undefined
        };
      }
    }
  };

  const client = new BrowserUpstreamClient(fakeContext as never, 'https://example.com/chat', {
    'content-type': 'application/json',
    'x-csrf-token': 'old-token'
  }, 1000);

  await client.post({ prompt: 'one' });
  await client.post({ prompt: 'two' });

  assert.equal(calls[0]?.maxRedirects, 0);
  assert.deepEqual(calls[0]?.data, { prompt: 'one' });
  assert.equal((calls[1]?.headers as Record<string, string>)['x-csrf-token'], 'new-token');
});
