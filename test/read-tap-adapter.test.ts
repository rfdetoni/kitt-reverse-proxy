import assert from 'node:assert/strict';
import test from 'node:test';
import { TapStreamAdapter } from '../src/runtime/read/tap-adapter.js';
import type { TapProfile } from '../src/runtime/read/types.js';

const encoder = new TextEncoder();

test('shadow tap learns a stable SSE text path only when it equals final DOM text', () => {
  const adapter = new TapStreamAdapter();
  adapter.matchedResponse('https://chat.example.com/api/chat', 'POST', 'text/event-stream');

  adapter.push(encoder.encode('data: {"delta":{"text":"Olá"}}\n\n'));
  adapter.push(encoder.encode('data: {"delta":{"text":"Olá mundo"}}\n\n'));
  adapter.end();

  const verified = adapter.verification('Olá mundo');
  assert.ok(verified);
  assert.equal(verified.profile.endpointOrigin, 'https://chat.example.com');
  assert.equal(verified.profile.endpointPath, '/api/chat');
  assert.equal(verified.profile.textPath, '$.delta.text');
  assert.equal(verified.text, 'Olá mundo');
});

test('active tap emits only suffixes for cumulative stream events and preserves split UTF-8', () => {
  const profile: TapProfile = {
    endpointOrigin: 'https://chat.example.com',
    endpointPath: '/api/chat',
    method: 'POST',
    contentType: 'text/event-stream',
    framing: 'sse',
    textPath: '$.delta.text'
  };
  const adapter = new TapStreamAdapter(profile);
  adapter.matchedResponse('https://chat.example.com/api/chat', 'POST', 'text/event-stream');

  const payload = encoder.encode(
    'data: {"delta":{"text":"Olá"}}\n\n' +
    'data: {"delta":{"text":"Olá 🌎"}}\n\n'
  );
  const globe = payload.findIndex((value, index) => value === 0xf0 && index > 0);
  assert.ok(globe > 0);

  const deltas = [
    ...adapter.push(payload.slice(0, globe + 1)),
    ...adapter.push(payload.slice(globe + 1, globe + 3)),
    ...adapter.push(payload.slice(globe + 3)),
    ...adapter.end()
  ];

  assert.deepEqual(deltas, ['Olá', ' 🌎']);
  assert.ok(adapter.verification('Olá 🌎'));
});

test('tap verification rejects a stream that diverges from canonical DOM text', () => {
  const profile: TapProfile = {
    endpointOrigin: 'https://chat.example.com',
    endpointPath: '/api/chat',
    method: 'POST',
    contentType: 'application/x-ndjson',
    framing: 'ndjson',
    textPath: '$.delta.text'
  };
  const adapter = new TapStreamAdapter(profile);
  adapter.matchedResponse('https://chat.example.com/api/chat', 'POST', 'application/x-ndjson');

  adapter.push(encoder.encode('{"delta":{"text":"154"}}\n'));
  adapter.end();

  assert.equal(adapter.verification('145'), undefined);
});
