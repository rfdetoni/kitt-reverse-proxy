import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUiHistoryHydration } from '../src/runtime/ui-history.js';

test('expanded current turn is not replayed as earlier history', () => {
  const task = 'Investigate Win32 API coverage\n\nValidate with evidence';
  const selected = [{ role: 'user' as const, text: `[KITT ORCHESTRATOR TURN DATA]\ncontext\n[END KITT ORCHESTRATOR TURN DATA]\n\n${task}`, omittedContextMessages: 1 }];
  const messages = [{ role: 'system', text: 'System' }, { role: 'user', text: task }];
  assert.equal(buildUiHistoryHydration(messages, selected, false), '');
});

test('previous conversation remains, expanded current turn is excluded', () => {
  const selected = [{ role: 'user' as const, text: 'metadata\n\nNew turn', omittedContextMessages: 3 }];
  const messages = [
    { role: 'system', text: 'System' },
    { role: 'user', text: 'Earlier turn' },
    { role: 'assistant', text: 'Earlier answer' },
    { role: 'user', text: 'New turn' }
  ];
  const hydrated = buildUiHistoryHydration(messages, selected, false);
  assert.match(hydrated, /USER:\nEarlier turn/);
  assert.match(hydrated, /ASSISTANT:\nEarlier answer/);
  assert.doesNotMatch(hydrated, /USER:\nNew turn/);
});

test('concatenated suffix without paragraph boundary does not discard turn', () => {
  const selected = [{ role: 'user' as const, text: 'unrelated prefixCurrent task', omittedContextMessages: 1 }];
  const messages = [{ role: 'system', text: 'System' }, { role: 'user', text: 'Current task' }];
  assert.match(buildUiHistoryHydration(messages, selected, false), /USER:\nCurrent task/);
});

test('existing browser history is never replayed', () => {
  const selected = [{ role: 'user' as const, text: 'Current task', omittedContextMessages: 1 }];
  const messages = [{ role: 'user', text: 'Current task' }];
  assert.equal(buildUiHistoryHydration(messages, selected, true), '');
});
