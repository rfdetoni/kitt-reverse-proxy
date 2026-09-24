import test from 'node:test';
import assert from 'node:assert/strict';
import { browserLaunchArgs, browserLaunchOptions } from '../src/runtime/browser-session.js';

test('local Chromium launch keeps the sandbox enabled by default', () => {
  const options = browserLaunchOptions(true, {});
  assert.equal(options.headless, false);
  assert.equal(options.chromiumSandbox, true);
  assert.equal(browserLaunchArgs().includes('--no-sandbox'), false);
});

test('container runtime may explicitly delegate isolation to its container boundary', () => {
  const options = browserLaunchOptions(false, { KITT_BROWSER_SANDBOX: '0' });
  assert.equal(options.headless, true);
  assert.equal(options.chromiumSandbox, false);
});
