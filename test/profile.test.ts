import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProfile } from '../src/mapping/profile.js';

test('profile validator accepts declarative mapping', () => {
  const profile = validateProfile({
    version: 2,
    request: { bindings: [{ target: '$.prompt', source: 'openai.last_user_text' }] },
    response: { contentPaths: ['$.answer'] }
  });
  assert.equal(profile.version, 2);
});

test('profile validator rejects executable/unknown sources', () => {
  assert.throws(() => validateProfile({
    version: 2,
    request: { bindings: [{ target: '$.prompt', source: 'javascript.eval' }] },
    response: { contentPaths: [] }
  }), /não suportado/);
});

test('profile validator accepts developer role remapping', async () => {
  const { validateProfile } = await import('../src/mapping/profile.js');
  const profile = validateProfile({
    version: 2,
    request: { bindings: [{
      target: '$.messages', source: 'openai.messages',
      transform: { type: 'message_array', rolePath: '$.role', contentPath: '$.content', roleMap: { developer: 'system' } }
    }] },
    response: { contentPaths: ['$.answer'] }
  });
  assert.equal(profile.request.bindings[0]?.transform?.type, 'message_array');
});
