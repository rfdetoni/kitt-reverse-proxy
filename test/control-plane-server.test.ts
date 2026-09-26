import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchControlRequest } from '../src/control-plane/server.js';

test('resident control plane preserves schema and profile lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kitt-rp-control-'));

  const created = await dispatchControlRequest({
    action: 'profiles.create',
    params: { name: 'context-google', provider: 'gemini' }
  }, root);
  assert.equal(created.schema_version, 1);
  const profile = created.profile as { id?: string; providers?: string[] };
  assert.equal(profile.id, 'context-google');
  assert.deepEqual(profile.providers, ['gemini']);

  const listed = await dispatchControlRequest({ action: 'profiles.list' }, root);
  const profiles = listed.profiles as Array<{ id: string }>;
  assert.deepEqual(profiles.map((item) => item.id), ['context-google']);

  const removed = await dispatchControlRequest({
    action: 'profiles.remove',
    params: { id: 'context-google' }
  }, root);
  assert.equal(removed.removed, true);
});

test('resident control plane rejects unknown actions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kitt-rp-control-'));
  await assert.rejects(
    dispatchControlRequest({ action: 'unknown.action' }, root),
    /Unknown control action/
  );
});
