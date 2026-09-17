import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import type { ProviderPreset } from '../src/providers/catalog.js';
import {
  applyReasoningEffort,
  parseReasoningEffortHeader,
  reasoningFallbackLevels,
  reasoningLevelForEffort
} from '../src/runtime/reasoning.js';

test('legacy reasoning headers are ignored by the reverse proxy', () => {
  for (const value of [undefined, '0', '50', '100', '-1', 'abc']) {
    assert.equal(parseReasoningEffortHeader(value), undefined);
  }
});

test('legacy effort mapping remains inert compatibility metadata', () => {
  assert.equal(reasoningLevelForEffort(0), 'instant');
  assert.equal(reasoningLevelForEffort(50), 'medium');
  assert.equal(reasoningLevelForEffort(80), 'high');
  assert.equal(reasoningLevelForEffort(100), 'extra_high');
});

test('reverse proxy never selects a fallback reasoning level', () => {
  assert.deepEqual(reasoningFallbackLevels('instant'), ['instant']);
  assert.deepEqual(reasoningFallbackLevels('medium'), ['medium']);
  assert.deepEqual(reasoningFallbackLevels('high'), ['high']);
  assert.deepEqual(reasoningFallbackLevels('extra_high'), ['extra_high']);
});

test('applyReasoningEffort is a no-op and does not access the WebChat page', async () => {
  const page = new Proxy({}, {
    get() {
      throw new Error('WebChat DOM must not be accessed for reasoning');
    }
  }) as Page;
  const provider = { id: 'chatgpt' } as ProviderPreset;

  const result = await applyReasoningEffort(page, provider, 50);

  assert.equal(result.requestedEffort, 50);
  assert.equal(result.requestedLevel, 'medium');
  assert.equal(result.changed, false);
  assert.equal(result.degraded, false);
});
