import test from 'node:test';
import assert from 'node:assert/strict';
import { selectorCandidates, semanticLocatorContract } from '../src/runtime/semantic-locator.js';

test('semantic locator keeps provider selectors first and appends unique fallbacks', () => {
  const candidates = selectorCandidates(['#provider-input', 'textarea:not([disabled]):not([readonly])'], 'composer');
  assert.equal(candidates[0]?.selector, '#provider-input');
  assert.equal(candidates[0]?.strategy, 'provider');
  assert.ok(candidates.some((item) => item.strategy === 'semantic'));
  assert.equal(
    candidates.filter((item) => item.selector === 'textarea:not([disabled]):not([readonly])').length,
    1
  );
  for (let index = 1; index < candidates.length; index += 1) {
    assert.ok(candidates[index - 1]!.priority < candidates[index]!.priority);
  }
});

test('semantic locator exposes a machine readable versioned contract', () => {
  const contract = semanticLocatorContract();
  assert.equal(contract.version, 1);
  assert.deepEqual(contract.strategy_order, ['provider', 'semantic']);
});
