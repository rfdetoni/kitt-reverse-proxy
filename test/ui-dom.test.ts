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

test('unchanged pre-existing assistant response is never reused for a new request', () => {
  const baseline: UiTextSnapshot[] = [
    { selector: '[assistant]', frameIndex: 0, count: 1, index: 0, identity: 'turn-old', priority: 0, text: 'old answer' }
  ];
  const current: UiTextSnapshot[] = [
    { selector: '[assistant]', frameIndex: 0, count: 1, index: 0, identity: 'turn-old', priority: 0, text: 'old answer' }
  ];
  assert.equal(selectChangedSnapshot(baseline, current, 'new question'), undefined);
});

test('virtualized assistant slot changing text is accepted as new response', () => {
  const baseline: UiTextSnapshot[] = [
    { selector: '[assistant]', frameIndex: 0, count: 1, index: 0, identity: 'slot-0', priority: 0, text: 'old answer' }
  ];
  const current: UiTextSnapshot[] = [
    { selector: '[assistant]', frameIndex: 0, count: 1, index: 0, identity: 'slot-0', priority: 0, text: 'new generated answer' }
  ];
  assert.equal(selectChangedSnapshot(baseline, current, 'question')?.text, 'new generated answer');
});

test('specific assistant selector outranks broad prompt echo', () => {
  const current: UiTextSnapshot[] = [
    { selector: '[assistant]', frameIndex: 0, count: 1, index: 0, identity: 'answer-1', priority: 0, text: 'real answer' },
    { selector: '.markdown', frameIndex: 0, count: 2, index: 1, identity: 'prompt-1', priority: 5, text: 'hello   world' }
  ];
  assert.equal(selectChangedSnapshot([], current, 'hello\nworld')?.text, 'real answer');
});
