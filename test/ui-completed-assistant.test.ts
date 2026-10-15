import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCompletedAssistantContract } from '../src/runtime/ui-dom.js';
import type { UiTextSnapshot } from '../src/runtime/ui-dom.js';

const completed = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":\"Finished task\",\"reasoning_summary\":\"\",\"loop\":null}";

test('completed assistant JSON may be recovered from a rich editor preformatted block', () => {
  assert.equal(selectCompletedAssistantContract(['Loading...', completed], []), completed);
  assert.equal(selectCompletedAssistantContract([completed.slice(0,-1)], []), undefined);
});

test('an old assistant envelope cannot be reused for a new request', () => {
  const baseline: UiTextSnapshot[] = [
    { selector: '[prior-assistant-contract]', frameIndex: -1, count: 1, text: completed }
  ];
  assert.equal(selectCompletedAssistantContract([completed], baseline), undefined);
});

test('two distinct completed assistant envelopes fail closed', () => {
  const other = completed.replace('Finished task', 'Different task');
  assert.equal(selectCompletedAssistantContract([completed, other], []), undefined);
});

test('completed compact JSON assistant output is recoverable but truncated output is not', () => {
  const compact = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":\"Validated.\",\"reasoning_summary\":\"\",\"loop\":null}";
  assert.equal(selectCompletedAssistantContract([compact], []), compact);
  assert.equal(selectCompletedAssistantContract([compact.slice(0,-1)], []), undefined);
  assert.equal(selectCompletedAssistantContract([compact], [{ selector: 'old', frameIndex: 0, count: 1, text: compact }]), undefined);
});
