import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedLogicalCompletion } from '../src/runtime/ui-response-monitor.js';

const valid = 'K2 F\nstate: done\nK2/END';
test('early completion requires identical strictly parsed assistant-owned current-turn frame', () => {
  assert.equal(verifiedLogicalCompletion(valid, valid), true);
  assert.equal(verifiedLogicalCompletion('', valid), false);
  assert.equal(verifiedLogicalCompletion(valid, ''), false);
  assert.equal(verifiedLogicalCompletion('K2 F\nstate: pending\nK2/END', valid), false);
});
test('terminator-only, ambiguous, malformed and legacy frames cannot finish early', () => {
  for (const invalid of [
    'K2/END',
    'K2 F\nstate: done',
    'K2 F\nstate: done\nK2/END\nK2 F\nstate: bad\nK2/END',
    'KITT/1\nACTION FINAL\nTEXT content\ndone\nKITT/ENDTEXT\nKITT/END',
    'K2 F\nstate: done\nK2/END\nextra',
  ]) {
    assert.equal(verifiedLogicalCompletion(valid, invalid), false);
  }
});
