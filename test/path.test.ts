import test from 'node:test';
import assert from 'node:assert/strict';
import { appendJsonPath, deleteJsonPath, getPathValues, setJsonPath } from '../src/util/path.js';
import type { JsonValue } from '../src/types.js';

test('path engine supports nested set/get and wildcard reads', () => {
  const root: JsonValue = { events: [{ delta: { text: 'a' } }, { delta: { text: 'b' } }] };
  assert.deepEqual(getPathValues(root, '$.events[*].delta.text'), ['a', 'b']);
  setJsonPath(root, '$.state.id', '123');
  assert.deepEqual(getPathValues(root, '$.state.id'), ['123']);
  deleteJsonPath(root, '$.state.id');
  assert.deepEqual(getPathValues(root, '$.state.id'), []);
});

test('path engine supports quoted keys used by RPC form fields', () => {
  const root: JsonValue = { 'f.req': [{ 'odd.key': 'value' }] };
  assert.deepEqual(getPathValues(root, '$["f.req"][0]["odd.key"]'), ['value']);
  setJsonPath(root, '$["f.req"][0]["odd.key"]', 'changed');
  assert.deepEqual(getPathValues(root, appendJsonPath(appendJsonPath('$', 'f.req') + '[0]', 'odd.key')), ['changed']);
});

test('path engine blocks prototype-pollution segments including quoted keys', () => {
  assert.throws(() => setJsonPath({}, '$.__proto__.polluted', true), /proibido/);
  assert.throws(() => setJsonPath({}, '$["constructor"].polluted', true), /proibido/);
});
