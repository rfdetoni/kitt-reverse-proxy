import test from 'node:test';
import assert from 'node:assert/strict';
import { createFallbackProfile } from '../src/mapping/fallback.js';
import { DeclarativeAdapter } from '../src/mapping/engine.js';

test('fallback discovers prompt request and answer response', () => {
  const profile = createFallbackProfile({ prompt: '', conversationId: 'c1' }, { answer: 'ok', conversationId: 'c2' }, 'https://example.com/chat');
  const adapter = new DeclarativeAdapter(profile, { prompt: '', conversationId: 'c1' }, 'web');
  adapter.validate();
  assert.equal(adapter.mapRequest({ messages: [{ role: 'user', content: 'hi' }] }).prompt, 'hi');
  assert.equal(adapter.mapResponse({ answer: 'back' }).choices[0]?.message.content, 'back');
});

test('fallback understands nested parts message arrays', () => {
  const sample = { contents: [{ role: 'user', parts: [{ text: 'captured' }] }] };
  const profile = createFallbackProfile(sample, { answer: 'ok' }, 'https://example.com/chat');
  const adapter = new DeclarativeAdapter(profile, sample, 'web');
  const mapped = adapter.mapRequest({ messages: [{ role: 'user', content: 'fresh' }] });
  assert.deepEqual(mapped.contents, [{ role: 'user', parts: [{ text: 'fresh' }] }]);
});
