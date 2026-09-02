import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalMessages, deltaFromCumulative, historyFingerprint, historyIsPrefix, selectMinimalUiPrompt } from '../src/runtime/ui-history.js';

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

test('browser policy sends only latest actionable turn without role labels', () => {
  const messages = canonicalMessages({
    messages: [
      { role: 'system', content: 'hidden policy' },
      { role: 'user', content: 'old user turn' },
      { role: 'assistant', content: 'old response' },
      { role: 'developer', content: 'hidden instruction' },
      { role: 'user', content: 'actual question' }
    ]
  });
  const selected = selectMinimalUiPrompt(messages);
  assert.equal(selected?.role, 'user');
  assert.equal(selected?.text, 'actual question');
  assert.equal(selected?.text.includes('System:'), false);
  assert.equal(selected?.text.includes('Assistant:'), false);
});

test('system/developer-only requests are not injected', () => {
  const messages = canonicalMessages({
    messages: [{ role: 'system', content: 'policy' }, { role: 'developer', content: 'instruction' }]
  });
  assert.equal(selectMinimalUiPrompt(messages), undefined);
});

test('tool result is raw only when latest actionable turn', () => {
  const messages = canonicalMessages({
    messages: [{ role: 'user', content: 'run tool' }, { role: 'tool', content: '42' }]
  });
  assert.deepEqual(selectMinimalUiPrompt(messages), {
    role: 'tool',
    text: '42',
    omittedContextMessages: 1
  });
});
