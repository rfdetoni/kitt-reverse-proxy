import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicImageAddress } from '../src/runtime/multimodal.js';

test('multimodal SSRF guard rejects private/reserved addresses', () => {
  assert.equal(isPublicImageAddress('127.0.0.1'), false);
  assert.equal(isPublicImageAddress('10.0.0.1'), false);
  assert.equal(isPublicImageAddress('169.254.169.254'), false);
  assert.equal(isPublicImageAddress('::1'), false);
  assert.equal(isPublicImageAddress('8.8.8.8'), true);
});
