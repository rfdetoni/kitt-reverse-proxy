import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectCompletedAssistantContract, selectCompletedAssistantContract} from '../src/runtime/ui-dom.js';
import type {Page} from 'playwright';

const valid = 'K2 F\nstatus: done\nK2/END';

test('a complete unique KAP/2 answer can be recovered without a role attribute', async () => {
  const page = {frames: () => [{
    isDetached: () => false,
    evaluate: async () => ({count: 0, structural: 2, samples: [valid]})
  }]} as unknown as Page;
  const found = await inspectCompletedAssistantContract(page, [], 'Different submitted prompt');
  assert.equal(found.text, valid);
  assert.equal(found.assistantNodes, 0);
  assert.equal(found.structuralTurnNodes, 2);
});

test('recovery never promotes submitted prompts, prior answers or ambiguous contracts', () => {
  assert.equal(selectCompletedAssistantContract([valid], [], 'prefix\n' + valid + '\nsuffix'), undefined);
  assert.equal(selectCompletedAssistantContract([valid], [{selector: '.markdown', frameIndex: 0, count: 1, text: valid}]), undefined);
  assert.equal(selectCompletedAssistantContract([valid, 'K2 F\nstatus: changed\nK2/END'], []), undefined);
  assert.equal(selectCompletedAssistantContract(['K2 F\nstatus: in progress'], []), undefined);
});
