import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidReasoningEffortError,
  parseReasoningEffortHeader,
  reasoningLevelForEffort
} from '../src/runtime/reasoning.js';

test('reasoning header accepts only canonical 0..100 integers', () => {
  assert.equal(parseReasoningEffortHeader(undefined), undefined);
  assert.equal(parseReasoningEffortHeader('0'), 0);
  assert.equal(parseReasoningEffortHeader('50'), 50);
  assert.equal(parseReasoningEffortHeader('100'), 100);

  for (const invalid of ['-1', '101', '80.5', 'abc']) {
    assert.throws(() => parseReasoningEffortHeader(invalid), InvalidReasoningEffortError);
  }
});

test('0..100 maps to ChatGPT reasoning tiers', () => {
  assert.equal(reasoningLevelForEffort(0), 'instant');
  assert.equal(reasoningLevelForEffort(20), 'instant');
  assert.equal(reasoningLevelForEffort(21), 'medium');
  assert.equal(reasoningLevelForEffort(50), 'medium');
  assert.equal(reasoningLevelForEffort(60), 'medium');
  assert.equal(reasoningLevelForEffort(61), 'high');
  assert.equal(reasoningLevelForEffort(90), 'high');
  assert.equal(reasoningLevelForEffort(91), 'extra_high');
  assert.equal(reasoningLevelForEffort(100), 'extra_high');
});
