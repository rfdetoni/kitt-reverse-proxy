import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KAP_CURRENT_VERSION, KAP_VERSION_HEADER,
  negotiateKAPVersion, KAPNegotiationError
} from '../src/contracts/kap-version.js';

test('KAP/2 exact header and legacy missing metadata work', () => {
  assert.equal(KAP_VERSION_HEADER, 'X-Kitt-KAP');
  assert.equal(negotiateKAPVersion(undefined), KAP_CURRENT_VERSION);
  assert.equal(negotiateKAPVersion('KAP/2'), KAP_CURRENT_VERSION);
});

test('unknown, malformed or ambiguous KAP versions fail closed', () => {
  for (const bad of ['KAP/1', 'KAP/3', 'K2/3', 'KAP/2,KAP/1', ' KAP/2', '', 'kap/2']) {
    assert.throws(() => negotiateKAPVersion(bad), KAPNegotiationError);
  }
});
