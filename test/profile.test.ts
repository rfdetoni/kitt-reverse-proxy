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
