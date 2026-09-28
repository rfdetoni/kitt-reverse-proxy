import test from 'node:test';
import assert from 'node:assert/strict';
import { uiResponseWatchdogBudget } from '../src/runtime/ui-response-monitor.js';

test('response watchdog extends active UI work with a bounded absolute budget', () => {
  assert.deepEqual(uiResponseWatchdogBudget(180_000), {
    inactivityMs: 180_000,
    absoluteMs: 360_000
  });
  assert.deepEqual(uiResponseWatchdogBudget(30_000), {
    inactivityMs: 30_000,
    absoluteMs: 150_000
  });
});
