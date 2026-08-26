import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTextBody } from '../src/discovery/decoder.js';

test('decoder understands XSSI-prefixed length-framed JSON', () => {
  const body = `)]}'\n\n42\n[["wrb.fr","rpc",["answer"]]]\n`;
  const decoded = decodeTextBody(body, 'application/json');
  assert.deepEqual(decoded, [['wrb.fr', 'rpc', ['answer']]]);
});

test('decoder parses SSE data events and ignores DONE', () => {
  const decoded = decodeTextBody('data: {"delta":"a"}\n\ndata: {"delta":"ab"}\n\ndata: [DONE]\n\n', 'text/event-stream');
  assert.deepEqual(decoded, { eventStream: [{ delta: 'a' }, { delta: 'ab' }] });
});
