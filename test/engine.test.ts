import test from 'node:test';
import assert from 'node:assert/strict';
import { DeclarativeAdapter } from '../src/mapping/engine.js';
import type { AdapterProfile } from '../src/types.js';

const profile: AdapterProfile = {
  version: 2,
  request: {
    bindings: [
      { target: '$.payload.text', source: 'openai.last_user_text' },
      { target: '$.payload.messageId', source: 'generated.uuid' }
    ]
  },
  response: { contentPaths: ['$.eventStream[*].delta'], joinStrategy: 'smart', separator: '' },
  state: { updates: [{ responsePath: '$.conversationId', requestTarget: '$.conversationId', optional: true }] }
};

test('declarative adapter maps requests without generated code', () => {
  const adapter = new DeclarativeAdapter(profile, { payload: { text: '', messageId: 'old' }, conversationId: 'c1' }, 'web');
  const request = adapter.mapRequest({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal((request.payload as Record<string, unknown>).text, 'hello');
  assert.notEqual((request.payload as Record<string, unknown>).messageId, 'old');
});

test('smart join handles cumulative stream snapshots', () => {
  const adapter = new DeclarativeAdapter(profile, { payload: { text: '', messageId: 'old' }, conversationId: 'c1' }, 'web');
  const completion = adapter.mapResponse({ eventStream: [{ delta: 'ol' }, { delta: 'olá' }] });
  assert.equal(completion.choices[0]?.message.content, 'olá');
});

test('state update changes the next request base', () => {
  const adapter = new DeclarativeAdapter(profile, { payload: { text: '', messageId: 'old' }, conversationId: 'c1' }, 'web');
  adapter.applyState({ conversationId: 'c2' });
  const request = adapter.mapRequest({ messages: [{ role: 'user', content: 'next' }] });
  assert.equal(request.conversationId, 'c2');
});

test('message_array transform supports nested target message shapes', () => {
  const nestedProfile: AdapterProfile = {
    version: 2,
    request: { bindings: [{ target: '$.contents', source: 'openai.messages', transform: { type: 'message_array', rolePath: '$.role', contentPath: '$.parts[0].text' } }] },
    response: { contentPaths: ['$.answer'] }
  };
  const adapter = new DeclarativeAdapter(nestedProfile, { contents: [] }, 'web');
  const mapped = adapter.mapRequest({ messages: [{ role: 'user', content: 'nested' }] });
  assert.deepEqual(mapped.contents, [{ role: 'user', parts: [{ text: 'nested' }] }]);
});


test('developer role participates in system_text mapping', () => {
  const systemProfile: AdapterProfile = {
    version: 2,
    request: { bindings: [
      { target: '$.prompt', source: 'openai.last_user_text' },
      { target: '$.system', source: 'openai.system_text', optional: true }
    ] },
    response: { contentPaths: ['$.answer'] }
  };
  const adapter = new DeclarativeAdapter(systemProfile, { prompt: '', system: '' }, 'web');
  const mapped = adapter.mapRequest({ messages: [
    { role: 'developer', content: 'follow policy' },
    { role: 'user', content: 'hello' }
  ] });
  assert.equal(mapped.system, 'follow policy');
});
