import test from 'node:test';
import assert from 'node:assert/strict';
import { awaitUiResponse, uiResponseAbsoluteBudget, uiResponseWatchdogBudget } from '../src/runtime/ui-response-monitor.js';
import { UiTimeoutError } from '../src/runtime/ui-errors.js';
import { detectProvider } from '../src/providers/catalog.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';

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

test('unrelated page mutations cannot indefinitely extend response inactivity', async () => {
  let wakeUps = 0;
  const session = {
    page: {
      frames: () => [],
      url: () => 'https://chatgpt.com/',
      evaluate: async () => { wakeUps++; return true; }
    }
  } as unknown as LiveBrowserSession;
  const config = { uiResponseTimeoutMs: 1_000, uiSettleMs: 100, headed: true } as AppConfig;
  await assert.rejects(
    awaitUiResponse(session, detectProvider('https://chatgpt.com'), config, [], 'prompt'),
    (error: unknown) => error instanceof UiTimeoutError && /Nenhum progresso/.test(error.message)
  );
  assert.ok(wakeUps > 1, 'test must include unrelated page mutation wake-ups');
});

test('actively generating WebChat is allowed up to 15 minutes, not the 4-minute contract cutoff', () => {
  assert.equal(uiResponseAbsoluteBudget(180_000, false), 360_000);
  assert.equal(uiResponseAbsoluteBudget(180_000, true), 900_000);
});

test('correlated CDP bytes extend response activity even without DOM text', async () => {
  const started = Date.now();
  const session = {
    page: {
      frames: () => [], url: () => 'https://chatgpt.com/',
      evaluate: async () => false
    }
  } as unknown as LiveBrowserSession;
  const config = {uiResponseTimeoutMs: 1000, uiSettleMs: 100, headed: true} as AppConfig;
  let tapTime = started;
  const heartbeat = setInterval(() => { tapTime = Date.now(); }, 150);
  setTimeout(() => clearInterval(heartbeat), 1600);
  try {
    await assert.rejects(
      awaitUiResponse(session, detectProvider('https://chatgpt.com'), config, [], 'prompt',
        undefined, undefined, () => ({lastByteAt: tapTime, receiving: true})),
      (error: unknown) => error instanceof UiTimeoutError && /Nenhum progresso/.test(error.message)
    );
    assert.ok(Date.now() - started >= 2000, 'tap activity must postpone inactivity timeout');
  } finally { clearInterval(heartbeat); }
});
