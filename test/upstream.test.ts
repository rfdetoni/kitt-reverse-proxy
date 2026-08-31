import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserUpstreamClient, UpstreamRedirectError } from '../src/runtime/upstream.js';

function response(status: number, headers: Record<string, string>, text: string) {
  return {
    status: () => status,
    headers: () => headers,
    text: async () => text,
    dispose: async () => undefined
  };
}

test('browser upstream blocks automatic redirects and rotates matching headers', async () => {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const fakeContext = {
    request: {
      async fetch(url: string, options: Record<string, unknown>) {
        calls.push({ url, options });
        return response(200, { 'content-type': 'application/json', 'x-csrf-token': calls.length === 1 ? 'new-token' : 'newer-token' }, '{"answer":"ok"}');
      }
    }
  };

  const client = new BrowserUpstreamClient(fakeContext as never, 'https://example.com/chat', {
    'content-type': 'application/json',
    'x-csrf-token': 'old-token'
  }, { kind: 'json', jsonStringPaths: [] }, 1000, false);

  await client.post({ prompt: 'one' });
  await client.post({ prompt: 'two' });

  assert.equal(calls[0]?.options.maxRedirects, 0);
  assert.deepEqual(calls[0]?.options.data, { prompt: 'one' });
  assert.equal((calls[1]?.options.headers as Record<string, string>)['x-csrf-token'], 'new-token');
});

test('same-origin redirects are followed manually with maxRedirects disabled', async () => {
  const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
  const fakeContext = {
    request: {
      async fetch(url: string, options: Record<string, unknown>) {
        calls.push({ url, options });
        if (calls.length === 1) return response(307, { location: '/chat/next', 'x-csrf-token': 'rotated' }, '');
        return response(200, { 'content-type': 'application/json' }, '{"answer":"ok"}');
      }
    }
  };
  const client = new BrowserUpstreamClient(fakeContext as never, 'https://example.com/chat', {
    'content-type': 'application/json', 'x-csrf-token': 'old'
  }, { kind: 'json', jsonStringPaths: [] }, 1000, true);
  await client.post({ prompt: 'hello' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.url, 'https://example.com/chat/next');
  assert.equal(calls[1]?.options.maxRedirects, 0);
  assert.equal((calls[1]?.options.headers as Record<string, string>)['x-csrf-token'], 'rotated');
  assert.deepEqual(calls[1]?.options.data, { prompt: 'hello' });
});

test('cross-origin redirect is blocked even when redirects are enabled', async () => {
  const fakeContext = {
    request: {
      async fetch() { return response(302, { location: 'https://evil.example/collect' }, ''); }
    }
  };
  const client = new BrowserUpstreamClient(fakeContext as never, 'https://example.com/chat', {
    authorization: 'Bearer session'
  }, { kind: 'json', jsonStringPaths: [] }, 1000, true);
  await assert.rejects(() => client.post({ prompt: 'hello' }), UpstreamRedirectError);
});

test('302 after POST switches to GET and removes body headers', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const fakeContext = {
    request: {
      async fetch(_url: string, options: Record<string, unknown>) {
        calls.push(options);
        if (calls.length === 1) return response(302, { location: '/result' }, '');
        return response(200, { 'content-type': 'application/json' }, '{"answer":"ok"}');
      }
    }
  };
  const client = new BrowserUpstreamClient(fakeContext as never, 'https://example.com/chat', {
    'content-type': 'application/json'
  }, { kind: 'json', jsonStringPaths: [] }, 1000, true);
  await client.post({ prompt: 'hello' });
  assert.equal(calls[1]?.method, 'GET');
  assert.equal(calls[1]?.data, undefined);
  assert.equal((calls[1]?.headers as Record<string, string>)['content-type'], undefined);
});
