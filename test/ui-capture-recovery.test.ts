import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProxyError } from '../src/core/errors.js';
import { UiTimeoutError, UiUncorrelatedCaptureError } from '../src/runtime/ui-errors.js';

test('uncorrelated submitted WebChat capture is recoverable only via explicit continue', () => {
  const result = describeProxyError(new UiUncorrelatedCaptureError(
    'CDP did not match current submitted prompt'
  ));
  assert.equal(result.status, 409);
  assert.equal(result.code, 'ui_capture_unverified');
  assert.equal(result.recoverable, true);
  assert.equal(result.recoveryAction, 'continue');
});

test('finished generation without attributable answer requires explicit continue', () => {
  const result = describeProxyError(new UiUncorrelatedCaptureError(
    'The UI finished generating but a current-turn response could not be attributed'
  ));
  assert.equal(result.status, 409);
  assert.equal(result.code, 'ui_capture_unverified');
  assert.equal(result.recoveryAction, 'continue');
  assert.equal(result.recoverable, true);
});

test('generic WebChat timeout remains nonrecoverable to avoid implicit replay', () => {
  const result = describeProxyError(new UiTimeoutError('WebChat did not respond'));
  assert.equal(result.code, 'ui_timeout');
  assert.equal(result.status, 504);
  assert.equal(result.recoverable, undefined);
});
