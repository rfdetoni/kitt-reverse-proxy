import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSensitiveForwardHeaders, sanitizeCapturedHeaders } from '../src/security/headers.js';
import { isTrustedBrowserOrigin } from '../src/proxy/server.js';
import { redactForModel } from '../src/security/redaction.js';

test('browser origins are limited to local loopback for mutable routes', () => {
  assert.equal(isTrustedBrowserOrigin(undefined), true);
  assert.equal(isTrustedBrowserOrigin('http://localhost:3000'), true);
  assert.equal(isTrustedBrowserOrigin('https://127.0.0.1:8443'), true);
  assert.equal(isTrustedBrowserOrigin('http://[::1]:3000'), true);
  assert.equal(isTrustedBrowserOrigin('https://evil.example'), false);
  assert.equal(isTrustedBrowserOrigin('null'), false);
  assert.equal(isTrustedBrowserOrigin('file:///tmp/test.html'), false);
});

test('captured cookies and hop-by-hop headers are not replayed manually', () => {
  const headers = sanitizeCapturedHeaders({ cookie: 'secret', host: 'x', authorization: 'Bearer x', 'x-custom': 'y' });
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.host, undefined);
  assert.equal(headers.authorization, 'Bearer x');
  assert.equal(headers['x-custom'], 'y');
});

test('model sample redaction hides content and tokens', () => {
  const redacted = redactForModel({ prompt: 'private question', token: 'abc', nested: { text: 'answer' } });
  assert.deepEqual(redacted, { prompt: '[TEXT]', token: '[REDACTED]', nested: { text: '[TEXT]' } });
});


test('sensitive replay headers are detected before redirect opt-in', () => {
  assert.equal(hasSensitiveForwardHeaders({ authorization: 'Bearer x' }), true);
  assert.equal(hasSensitiveForwardHeaders({ 'x-csrf-token': 'x' }), true);
  assert.equal(hasSensitiveForwardHeaders({ 'content-type': 'application/json' }), false);
});

test('model redaction applies global object and node budgets', () => {
  const huge: Record<string, string> = {};
  for (let i = 0; i < 200; i += 1) huge[`key${i}`] = `value-${i}`;
  const redacted = redactForModel(huge);
  assert.equal(typeof redacted, 'object');
  assert.equal(Array.isArray(redacted), false);
  assert.equal((redacted as Record<string, unknown>).__truncated__, 120);
});
