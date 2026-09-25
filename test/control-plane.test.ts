import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { InstanceRegistry } from '../src/control-plane/instance-registry.js';
import { ProfileRegistry } from '../src/control-plane/profile-registry.js';
import { resolveServiceTarget } from '../src/control-plane/service-manager.js';

test('named browser profiles are reusable provider metadata without storing credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'kitt-rp-profile-'));
  const profiles = new ProfileRegistry(root);
  const profile = profiles.create('Pessoal', ['gemini']);
  profiles.markProvider(profile.id, 'chatgpt');

  const stored = profiles.get('pessoal');
  assert.ok(stored);
  assert.deepEqual(stored.providers.sort(), ['chatgpt', 'gemini']);
  assert.equal(stored.directory, join(root, 'profiles', 'pessoal'));
  assert.equal(JSON.stringify(stored).includes('password'), false);
});

test('legacy provider directories are imported without moving browser data', () => {
  const root = mkdtempSync(join(tmpdir(), 'kitt-rp-legacy-'));
  mkdirSync(join(root, 'gemini'), { recursive: true });
  const profiles = new ProfileRegistry(root);
  const imported = profiles.importLegacy(['gemini']);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].id, 'gemini-default');
  assert.equal(imported[0].legacy, true);
  assert.equal(imported[0].directory, join(root, 'gemini'));
});

test('instance registry keeps multiple independent reverse-proxy endpoints', () => {
  const root = mkdtempSync(join(tmpdir(), 'kitt-rp-instance-'));
  const registry = new InstanceRegistry(root);
  registry.put({
    id: 'gemini-context',
    provider: 'gemini',
    model: 'gemini-web',
    target: 'gemini',
    profileId: 'gemini-context',
    profileDirectory: join(root, 'profiles', 'gemini-context'),
    host: '127.0.0.1',
    port: 3000,
    pid: process.pid,
    startedAt: new Date().toISOString()
  });
  registry.put({
    id: 'chatgpt-code',
    provider: 'chatgpt',
    model: 'chatgpt-web',
    target: 'chatgpt',
    profileId: 'chatgpt-code',
    profileDirectory: join(root, 'profiles', 'chatgpt-code'),
    host: '127.0.0.1',
    port: 3001,
    pid: process.pid,
    startedAt: new Date().toISOString()
  });
  assert.deepEqual(registry.listActive().map((item) => item.id).sort(), ['chatgpt-code', 'gemini-context']);
});

test('Gemini Context and ChatGPT Code resolve to independent canonical plugins', () => {
  const context = resolveServiceTarget('gemini');
  const code = resolveServiceTarget('chatgpt');

  assert.equal(context.provider, 'gemini');
  assert.equal(context.model, 'gemini-web');
  assert.equal(code.provider, 'chatgpt');
  assert.equal(code.model, 'chatgpt-web');
  assert.notEqual(context.targetUrl, code.targetUrl);
});
