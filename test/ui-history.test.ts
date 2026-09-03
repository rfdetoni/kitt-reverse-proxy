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
test('tool prompt keeps call_id/name for agent continuation', () => {
  const messages = canonicalMessages({
    messages: [{
      role: 'tool',
      tool_call_id: 'call_weather',
      name: 'get_weather',
      content: '{"temp":18}'
    }]
  });
  assert.deepEqual(selectMinimalUiPrompt(messages), {
    role: 'tool',
    text: '{"temp":18}',
    omittedContextMessages: 0,
    toolCallId: 'call_weather',
    toolName: 'get_weather'
  });
});


test('Ollama tool_name is normalized as generic tool metadata', () => {
  const messages = canonicalMessages({
    messages: [{ role: 'tool', tool_name: 'weather', content: '{"temp":18}' }]
  });
  assert.equal(messages[0]?.toolName, 'weather');
});

test('parallel trailing tool outputs are all selected and history is not', async () => {
  const { selectMinimalUiPrompts } = await import('../src/runtime/ui-history.js');
  const messages = canonicalMessages({
    messages: [
      { role: 'user', content: 'compare weather' },
      { role: 'assistant', content: 'calling tools' },
      { role: 'tool', tool_call_id: 'call_a', name: 'weather_a', content: 'A' },
      { role: 'tool', tool_call_id: 'call_b', name: 'weather_b', content: 'B' }
    ]
  });
  const selected = selectMinimalUiPrompts(messages);
  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((item) => item.toolCallId), ['call_a', 'call_b']);
  assert.deepEqual(selected.map((item) => item.text), ['A', 'B']);
});


test('user turn compatibility detects a different full conversation', async () => {
  const { userTurnsAreCompatible } = await import('../src/runtime/ui-history.js');
  const previous = canonicalMessages({
    messages: [
      { role: 'user', content: 'conversation A' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'follow up' }
    ]
  });
  const same = canonicalMessages({
    messages: [
      { role: 'user', content: 'conversation A' },
      { role: 'assistant', content: 'different serialization is irrelevant' },
      { role: 'user', content: 'follow up' },
      { role: 'assistant', content: 'answer 2' },
      { role: 'user', content: 'next' }
    ]
  });
  const other = canonicalMessages({ messages: [{ role: 'user', content: 'conversation B' }, { role: 'user', content: 'next' }] });
  assert.equal(userTurnsAreCompatible(previous, same), true);
  assert.equal(userTurnsAreCompatible(previous, other), false);
});


test('assistant-tail request never reselects an earlier user message', () => {
  const messages = canonicalMessages({
    messages: [
      { role: 'user', content: 'do not resend me' },
      { role: 'assistant', content: 'already answered' }
    ]
  });
  assert.equal(selectMinimalUiPrompt(messages), undefined);
});
