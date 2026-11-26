import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { parseCliArgs } from '../src/config.js';
import { startProxyServer } from '../src/proxy/server.js';
import { startControlServer } from '../src/control-plane/server.js';

test('vmApiKey restricts management routes and enforces vmAllowedModels', async () => {
  const config = parseCliArgs([
    'https://chatgpt.com/',
    '--api-key', 'admin-secret-token-123456',
    '--vm-api-key', 'vm-scoped-token-123456',
    '--vm-allowed-models', 'allowed-model'
  ]);
  assert.ok(!('help' in config));

  const server = await startProxyServer({
    config,
    executor: {
      modelId: 'allowed-model',
      transport: 'ui',
      describe: () => ({}),
      execute: async () => ({
        completion: {
          id: 'cmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'allowed-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
        },
        deltas: ['ok']
      })
    }
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const mgmtDenied = await fetch(`${base}/v1/kitt/status`, {
      headers: { Authorization: 'Bearer vm-scoped-token-123456' }
    });
    assert.equal(mgmtDenied.status, 403);

    const mgmtAllowed = await fetch(`${base}/v1/kitt/status`, {
      headers: { Authorization: 'Bearer admin-secret-token-123456' }
    });
    assert.equal(mgmtAllowed.status, 200);

    const modelDenied = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer vm-scoped-token-123456',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'forbidden-model', messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(modelDenied.status, 403);

    const anthropicDenied = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer vm-scoped-token-123456',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'forbidden-model', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(anthropicDenied.status, 403);

    const ollamaDenied = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer vm-scoped-token-123456',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'forbidden-model', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(ollamaDenied.status, 403);

    const modelAllowed = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer vm-scoped-token-123456',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'allowed-model', messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(modelAllowed.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('control server rejects untrusted Origin and non-loopback Host', async () => {
  const server = await startControlServer(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const badOrigin = await fetch(`http://127.0.0.1:${port}/v1/control`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ action: 'profiles.list' })
    });
    assert.equal(badOrigin.status, 403);

    const okRes = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(okRes.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
