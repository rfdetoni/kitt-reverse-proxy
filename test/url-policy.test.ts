import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAllowedEndpoint } from '../src/security/url-policy.js';

test('same host and direct subdomains are accepted', () => {
  assert.equal(assertAllowedEndpoint('https://example.com/chat', 'https://api.example.com/v1/chat').hostname, 'api.example.com');
  assert.equal(assertAllowedEndpoint('https://example.com/chat', 'https://example.com/v1/chat').hostname, 'example.com');
});

test('sibling host requires explicit allowlist', () => {
  assert.throws(() => assertAllowedEndpoint('https://www.example.com/chat', 'https://api.example.com/v1/chat'), /fora do host/);
  assert.equal(
    assertAllowedEndpoint('https://www.example.com/chat', 'https://api.example.com/v1/chat', ['api.example.com']).hostname,
    'api.example.com'
  );
});

test('multi-tenant sibling domains are not implicitly trusted', () => {
  assert.throws(() => assertAllowedEndpoint('https://alice.github.io/chat', 'https://bob.github.io/api'), /fora do host/);
});

test('external backend requires explicit allowlist', () => {
  assert.throws(() => assertAllowedEndpoint('https://example.com/chat', 'https://chat.vendor.net/api'), /fora do host/);
  assert.equal(
    assertAllowedEndpoint('https://example.com/chat', 'https://chat.vendor.net/api', ['vendor.net']).hostname,
    'chat.vendor.net'
  );
});
