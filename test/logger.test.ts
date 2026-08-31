import test from 'node:test';
import assert from 'node:assert/strict';
import { safeUrlForLog, sanitizeLogMessage } from '../src/logger.js';

test('signed URL query and fragment are redacted from logs', () => {
  assert.equal(safeUrlForLog('https://example.com/chat?token=secret#frag'), 'https://example.com/chat?[redacted]');
  const message = sanitizeLogMessage('request failed https://example.com/chat?sig=abc&x=1');
  assert.equal(message.includes('sig=abc'), false);
  assert.match(message, /\?\[redacted\]/);
});
