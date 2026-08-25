import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowedEndpoint } from '../src/security/url-policy.js';

test('same registrable site is accepted for common multi-level suffix', () => {
  assert.equal(
    assertAllowedEndpoint('https://www.example.com.br/chat', 'https://api.example.com.br/v1/chat').hostname,
    'api.example.com.br'
  );
});

test('external backend requires explicit allowlist', () => {
  assert.throws(() => assertAllowedEndpoint('https://example.com/chat', 'https://chat.vendor.net/api'), /fora do site/);
  assert.equal(
    assertAllowedEndpoint('https://example.com/chat', 'https://chat.vendor.net/api', ['vendor.net']).hostname,
    'chat.vendor.net'
  );
});
