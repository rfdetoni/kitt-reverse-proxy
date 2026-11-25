import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedLabelMatches } from '../src/runtime/chatgpt-model-verification.js';
import { ChatGptModelNotVerifiedError } from '../src/runtime/chatgpt-model-verification.js';
import { describeProxyError } from '../src/core/errors.js';

test('exact selected UI label is required without hardcoded model aliases', () => {
  assert.equal(selectedLabelMatches(['Example  Model'], 'example model'), true);
  assert.equal(selectedLabelMatches(['Example model mini'], 'example model'), false);
  assert.equal(selectedLabelMatches(['Example model', 'another selection'], 'example model'), false);
  assert.equal(selectedLabelMatches([], 'example model'), false);
  assert.equal(describeProxyError(new ChatGptModelNotVerifiedError()).status, 409);
});
