import test from 'node:test';
import assert from 'node:assert/strict';
import { prependDirectiveToLastInteractiveMessage } from '../src/runtime/network-executor.js';

test('policy emulation copies only the interactive message it changes', () => {
  const system = { role: 'system', content: { stable: true } };
  const assistant = { role: 'assistant', content: 'cached answer' };
  const user = { role: 'user', content: { text: 'next task', metadata: { keep: true } } };
  const original = [system, assistant, user];

  const result = prependDirectiveToLastInteractiveMessage(original, '[directive]\n');

  assert.notEqual(result, original);
  assert.equal(result[0], system);
  assert.equal(result[1], assistant);
  assert.notEqual(result[2], user);
  assert.deepEqual(user, {
    role: 'user',
    content: { text: 'next task', metadata: { keep: true } }
  });
  assert.equal(
    (result[2] as { content: string }).content,
    '[directive]\n{"text":"next task","metadata":{"keep":true}}'
  );
});

test('policy emulation targets the last user or tool turn', () => {
  const firstUser = { role: 'user', content: 'first' };
  const tool = { role: 'tool', content: 'result' };
  const assistant = { role: 'assistant', content: 'after' };

  const result = prependDirectiveToLastInteractiveMessage(
    [firstUser, tool, assistant],
    'D:'
  );

  assert.equal(result[0], firstUser);
  assert.notEqual(result[1], tool);
  assert.equal((result[1] as { content: string }).content, 'D:result');
  assert.equal(result[2], assistant);
});
