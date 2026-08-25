import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRequestCandidate } from '../src/discovery/scoring.js';

test('chat-shaped request scores above analytics request', () => {
  const chat = scoreRequestCandidate('https://example.com/api/chat/messages', { messages: [{ role: 'user', content: 'hi' }] }, 'fetch');
  const analytics = scoreRequestCandidate('https://example.com/analytics/event', { event: 'click', page: 'home' }, 'fetch');
  assert.ok(chat > analytics + 40);
});
