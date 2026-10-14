import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKAP } from '../src/contracts/kap.js';
import { KAP2Error } from '../src/contracts/kap2.js';
import { transportPayload } from '../src/runtime/read/contract-text.js';

const payload = '{"items":[{"local_id":"T00","kind":"task","paths":["src/__init__.py"],"depends_on":[]},{"local_id":"FINAL","kind":"final","paths":[],"depends_on":["T00"]}]}';

test('compact KAP/2 structured final passes proxy validation and transport extraction', () => {
  for (const sep of [' ', '\n', '\r\n']) {
    const text = 'K2 F @json: ' + payload + sep + 'K2/END';
    const parsed = parseKAP(text);
    assert.equal(parsed.action, 'final_response');
    assert.equal((parsed.content as {items: unknown[]}).items.length, 2);
    assert.deepEqual(transportPayload(text),parsed);
  }
});

test('compact @json is strict, bounded and action-specific', () => {
  const rejects = [
    'K2 F @json: {"a":1,"a":2} K2/END',
    'K2 F @json: {"__proto__":1} K2/END',
    'K2 F @json: {"items":[1,]} K2/END',
    'K2 F @json: {"items":["src/\\_init.py"]} K2/END',
    'K2 T @json: {"items":[]} K2/END',
    'K2 F items[1]: - local_id: T00 K2/END',
  ];
  for (const text of rejects) assert.throws(() => parseKAP(text),KAP2Error,text);
  assert.deepEqual({...parseKAP('K2 F\ncontent: legacy\nK2/END').content as Record<string, unknown>},{content:'legacy'});
});

test('real planner-style compact JSON with missing FINAL is syntactically valid but not semantically complete', () => {
  const text='K2 F @json: {"items":[{"local_id":"T00","kind":"task","success_criteria":["ok"]}]}\\nK2/END'
    .replace('\\n','\n');
  assert.deepEqual((parseKAP(text).content as {items: unknown[]}).items.length,1);
  // The proxy does not invent a FINAL entry. The host validates the plan.
});
