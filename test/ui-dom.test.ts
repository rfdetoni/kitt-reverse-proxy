import test from 'node:test';
import assert from 'node:assert/strict';
import { selectChangedSnapshot, type UiTextSnapshot } from '../src/runtime/ui-dom.js';

test('changed UI snapshot is matched against the same selector and frame', () => {
  const baseline: UiTextSnapshot[] = [
    { selector: '.a', frameIndex: 0, count: 1, text: 'old' },
    { selector: '.b', frameIndex: 1, count: 2, text: 'other' }
  ];
  const current: UiTextSnapshot[] = [
    { selector: '.a', frameIndex: 0, count: 1, text: 'old' },
    { selector: '.b', frameIndex: 1, count: 3, text: 'answer' }
  ];
  assert.equal(selectChangedSnapshot(baseline, current)?.text, 'answer');
});

test('prompt echo is ignored as assistant response', () => {
  const result = selectChangedSnapshot([], [{ selector: '.x', frameIndex: 0, count: 1, text: 'hello' }], 'hello');
  assert.equal(result, undefined);
});
