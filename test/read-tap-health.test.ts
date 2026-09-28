import assert from 'node:assert/strict';
import test from 'node:test';
import { TapHealthController } from '../src/runtime/read/tap-health.js';
import type { TapProfile } from '../src/runtime/read/types.js';

const profile: TapProfile = {
  endpointOrigin: 'https://chat.example.com',
  endpointPath: '/api/chat',
  method: 'POST',
  contentType: 'text/event-stream',
  framing: 'sse',
  textPath: '$.delta.text'
};

test('tap stays in shadow until consecutive verifications promote it', () => {
  const health = new TapHealthController(3, 5_000, 3);
  health.setAttached(true);

  assert.equal(health.turnMode('auto').mode, 'shadow');
  health.recordVerified(profile);
  assert.equal(health.turnMode('auto').mode, 'shadow');
  health.recordVerified(profile);
  assert.equal(health.turnMode('auto').mode, 'shadow');
  health.recordVerified(profile);
  assert.equal(health.turnMode('auto').mode, 'active');
  assert.equal(health.snapshot().trusted, true);
});

test('tap mismatch immediately demotes trust and discards learned profile', () => {
  const health = new TapHealthController(3, 5_000, 1);
  health.setAttached(true);
  health.recordVerified(profile);
  assert.equal(health.turnMode('auto').mode, 'active');

  health.recordFailure('verify_mismatch', 1_000);
  assert.equal(health.snapshot(1_000).trusted, false);
  assert.equal(health.snapshot(1_000).learned, false);
  assert.equal(health.turnMode('auto', 1_000).mode, 'shadow');
});

test('tap breaker opens independently and returns to shadow probing after cooldown', () => {
  const health = new TapHealthController(2, 1_000, 2);
  health.setAttached(true);
  health.recordFailure('stall', 1_000);
  health.recordFailure('stall', 1_100);

  assert.equal(health.turnMode('auto', 1_500).mode, 'disabled');
  assert.equal(health.snapshot(1_500).circuit, 'open');

  assert.equal(health.turnMode('auto', 2_101).mode, 'shadow');
  assert.equal(health.snapshot(2_101).circuit, 'half_open');
  assert.equal(health.turnMode('auto', 2_102).mode, 'shadow');

  health.recordVerified(profile);
  assert.equal(health.snapshot(2_103).circuit, 'closed');
});

test('DOM mode is a hard kill switch even when tap is trusted', () => {
  const health = new TapHealthController(3, 5_000, 1);
  health.setAttached(true);
  health.recordVerified(profile);

  const decision = health.turnMode('dom');
  assert.equal(decision.mode, 'disabled');
  assert.equal(decision.reason, 'tap_disabled');
});
