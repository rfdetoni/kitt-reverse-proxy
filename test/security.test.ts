import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCapturedHeaders } from '../src/security/headers.js';
import { redactForModel } from '../src/security/redaction.js';

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
