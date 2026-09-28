import assert from 'node:assert/strict';
import test from 'node:test';
import { ResponseReconciler } from '../src/runtime/read/reconciler.js';

test('active tap can hand off to DOM without duplicating an already emitted prefix', async () => {
  const reconciler = new ResponseReconciler('auto', 'active', undefined, Date.now());
  await reconciler.tapDelta('Olá');
  await reconciler.domDelta('Olá');
  await reconciler.domDelta(' mundo');
  await reconciler.fallback('stall');

  const result = await reconciler.finalize('Olá mundo!', false, false);
  assert.deepEqual(result.deltas, ['Olá', ' mundo', '!']);
  assert.equal(result.diagnostics.source, 'dom');
  assert.equal(result.diagnostics.fallback_reason, 'stall');
});

test('divergent DOM rewrite never emits duplicate or contradictory suffix during handoff', async () => {
  const reconciler = new ResponseReconciler('auto', 'active', undefined, Date.now());
  await reconciler.tapDelta('Olá mun');
  await reconciler.domDelta('Olá, mundo!');
  await reconciler.fallback('verify_mismatch');

  const result = await reconciler.finalize('Olá, mundo!', false, false);
  assert.deepEqual(result.deltas, ['Olá mun']);
  assert.equal(result.diagnostics.source, 'dom');
  assert.equal(result.diagnostics.fallback_reason, 'verify_mismatch');
});

test('shadow mode streams only DOM while tap remains observation-only', async () => {
  const reconciler = new ResponseReconciler('auto', 'shadow', undefined, Date.now());
  await reconciler.tapDelta('tap-only');
  await reconciler.domDelta('DOM');
  const result = await reconciler.finalize('DOM final', true, false);

  assert.deepEqual(result.deltas, ['DOM', ' final']);
  assert.equal(result.diagnostics.source, 'dom');
  assert.equal(result.diagnostics.tap_verified, true);
});
