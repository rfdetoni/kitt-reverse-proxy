import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteJsonPath, getPathValues, setJsonPath } from '../src/util/path.js';
import type { JsonValue } from '../src/types.js';

test('path engine supports nested set/get and wildcard reads', () => {
  const root: JsonValue = { events: [{ delta: { text: 'a' } }, { delta: { text: 'b' } }] };
  assert.deepEqual(getPathValues(root, '$.events[*].delta.text'), ['a', 'b']);
  setJsonPath(root, '$.state.id', '123');
  assert.deepEqual(getPathValues(root, '$.state.id'), ['123']);
  deleteJsonPath(root, '$.state.id');
  assert.deepEqual(getPathValues(root, '$.state.id'), []);
});

test('path engine blocks prototype-pollution segments', () => {
  assert.throws(() => setJsonPath({}, '$.__proto__.polluted', true), /proibido/);
});
