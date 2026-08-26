import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRequestBody, encodeRequestBody } from '../src/discovery/body-codec.js';
import { getPathValues, setJsonPath } from '../src/util/path.js';

test('form codec decodes and re-encodes structured f.req payloads', () => {
  const original = new URLSearchParams({
    'f.req': JSON.stringify([['rpc', JSON.stringify({ prompt: 'hello', nested: [1, 2] })]]),
    at: 'static-token'
  }).toString();
  const decoded = decodeRequestBody(original, 'application/x-www-form-urlencoded;charset=UTF-8');
  if (!decoded) throw new Error('decode failed');
  assert.equal(decoded.codec.kind, 'form');
  assert.deepEqual(getPathValues(decoded.body, '$["f.req"][0][1].prompt'), ['hello']);
  setJsonPath(decoded.body, '$["f.req"][0][1].prompt', 'changed');

  const encoded = encodeRequestBody(decoded.body, decoded.codec);
  assert.equal(typeof encoded, 'string');
  const params = new URLSearchParams(encoded as string);
  const outer = JSON.parse(params.get('f.req')!) as unknown[][];
  const nested = JSON.parse(outer[0]![1] as string) as { prompt: string };
  assert.equal(nested.prompt, 'changed');
  assert.equal(params.get('at'), 'static-token');
});

test('JSON codec remains an object', () => {
  const decoded = decodeRequestBody('{"prompt":"hello"}', 'application/json');
  if (!decoded) throw new Error('decode failed');
  assert.equal(decoded.codec.kind, 'json');
  assert.deepEqual(encodeRequestBody(decoded.body, decoded.codec), { prompt: 'hello' });
});
