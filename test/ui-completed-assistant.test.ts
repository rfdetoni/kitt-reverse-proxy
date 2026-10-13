import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCompletedAssistantContract } from '../src/runtime/ui-dom.js';
import type { UiTextSnapshot } from '../src/runtime/ui-dom.js';

const completed = 'KITT/1\nACTION FINAL\nTEXT content\nFinished task\nKITT/ENDTEXT\nKITT/END';

test('completed assistant KAP may be recovered from a rich editor preformatted block', () => {
  assert.equal(selectCompletedAssistantContract(['Loading...', completed], []), completed);
  assert.equal(selectCompletedAssistantContract([completed.replace('KITT/END', '')], []), undefined);
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
