import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedLogicalCompletion } from '../src/runtime/ui-response-monitor.js';

const valid = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"state\":\"done\"},\"reasoning_summary\":\"\",\"loop\":null}";
test('early completion requires identical strictly parsed assistant-owned current-turn frame', () => {
  assert.equal(verifiedLogicalCompletion(valid, valid), true);
  assert.equal(verifiedLogicalCompletion('', valid), false);
  assert.equal(verifiedLogicalCompletion(valid, ''), false);
  assert.equal(verifiedLogicalCompletion("{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"state\":\"pending\"},\"reasoning_summary\":\"\",\"loop\":null}", valid), false);
});
test('terminator-only, ambiguous, malformed and legacy frames cannot finish early', () => {
  for (const invalid of [
    'K2/END',
    'K2 F\nstate: done',
    'K2 F\nstate: done\nK2/END\nK2 F\nstate: bad\nK2/END',
    "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":\"done\",\"reasoning_summary\":\"\",\"loop\":null}",
    'K2 F\nstate: done\nK2/END\nextra',
  ]) {
    assert.equal(verifiedLogicalCompletion(valid, invalid), false);
  }
});
