import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, resolveTransport } from '../src/providers/catalog.js';

test('known AI web apps default to UI transport', () => {
  for (const [url, id] of [
    ['https://chatgpt.com/', 'chatgpt'],
    ['https://claude.ai/new', 'claude'],
    ['https://gemini.google.com/app', 'gemini'],
    ['https://www.kimi.com/', 'kimi'],
    ['https://chat.deepseek.com/', 'deepseek']
  ] as const) {
    const provider = detectProvider(url);
    assert.equal(provider.id, id);
    assert.equal(resolveTransport('auto', provider), 'ui');
  }
});

test('unknown chat defaults to generic network discovery', () => {
  const provider = detectProvider('https://example.com/support/chat');
  assert.equal(provider.id, 'generic');
  assert.equal(resolveTransport('auto', provider), 'network');
});
