import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMessages, deltaFromCumulative, historyFingerprint, historyIsPrefix } from '../src/runtime/ui-history.js';

test('canonical history keeps developer instructions and fingerprints exact retries', () => {
  const body = { messages: [{ role: 'developer', content: 'policy' }, { role: 'user', content: 'hello' }] };
  const messages = canonicalMessages(body);
  assert.equal(messages[0]?.role, 'developer');
  assert.equal(historyFingerprint(messages), historyFingerprint(canonicalMessages(body)));
  assert.equal(historyIsPrefix(messages, [...messages, { role: 'assistant', text: 'ok' }]), true);
});

test('cumulative DOM snapshots produce only safe suffix deltas', () => {
  assert.equal(deltaFromCumulative('', 'Hello'), 'Hello');
  assert.equal(deltaFromCumulative('Hello', 'Hello world'), ' world');
  assert.equal(deltaFromCumulative('Hello world', 'rewritten'), '');
});
