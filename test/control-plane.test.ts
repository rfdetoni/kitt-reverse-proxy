import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { InstanceRegistry } from '../src/control-plane/instance-registry.js';
import { ProfileRegistry } from '../src/control-plane/profile-registry.js';
import { processFingerprint } from '../src/control-plane/process-identity.js';
import {
  browserHostPoolEnabled,
  canReuseBrowserHost,
  resolveServiceTarget,
  SERVICE_READY_TIMEOUT_MS
} from '../src/control-plane/service-manager.js';

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
  assert.equal(imported[0]!.id, 'gemini-default');
  assert.equal(imported[0]!.legacy, true);
  assert.equal(imported[0]!.directory, join(root, 'gemini'));
});

test('instance registry keeps multiple independent reverse-proxy endpoints', () => {
  const fingerprint = processFingerprint(process.pid);
  assert.ok(fingerprint);
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
    processFingerprint: fingerprint,
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
    processFingerprint: fingerprint,
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


test('managed service readiness budget allows interactive browser startup', () => {
  assert.equal(SERVICE_READY_TIMEOUT_MS, 330_000);
});

test('browser host pooling never crosses the Gemini human-auth boundary', () => {
  assert.equal(browserHostPoolEnabled('gemini'), false);
  assert.equal(browserHostPoolEnabled('chatgpt', {}), true);
  assert.equal(
    browserHostPoolEnabled('chatgpt', { PROXY_BROWSER_HOST_POOL: 'false' }),
    false
  );
});

test('browser host reuse requires a live host inside the same instance boundary', () => {
  const fingerprint = processFingerprint(process.pid);
  assert.ok(fingerprint);
  const owner = {
    id: 'chatgpt-a',
    provider: 'chatgpt',
    model: 'chatgpt-web',
    target: 'chatgpt',
    profileId: 'shared',
    profileDirectory: '/tmp/shared',
    host: '127.0.0.1',
    port: 3000,
    pid: process.pid,
    processFingerprint: fingerprint,
    startedAt: new Date().toISOString(),
    browserHostPid: 777,
    browserHostFingerprint: 'browser-fingerprint',
    browserHostCdpPort: 39000,
    browserHostMode: 'shared-profile' as const
  };
  assert.equal(canReuseBrowserHost(owner, 'chatgpt', () => true), true);
  assert.equal(canReuseBrowserHost(owner, 'chatgpt', () => false), false);
  assert.equal(canReuseBrowserHost(owner, 'gemini', () => true), false);
});


test('instance registry invalidates its hot cache after an external writer changes the file', () => {
  const fingerprint = processFingerprint(process.pid);
  assert.ok(fingerprint);
  const root = mkdtempSync(join(tmpdir(), 'kitt-rp-registry-cache-'));
  const first = new InstanceRegistry(root);
  const second = new InstanceRegistry(root);
  const record = (id: string, port: number) => ({
    id,
    provider: 'chatgpt',
    model: 'chatgpt-web',
    target: 'chatgpt',
    profileId: id,
    profileDirectory: join(root, 'profiles', id),
    host: '127.0.0.1',
    port,
    pid: process.pid,
    processFingerprint: fingerprint,
    startedAt: new Date().toISOString()
  });

  first.put(record('first', 3000));
  assert.deepEqual(first.list().map((item) => item.id), ['first']);

  second.put(record('second', 3001));
  const registryFile = join(root, 'control', 'instances.json');
  const future = new Date(Date.now() + 2_000);
  utimesSync(registryFile, future, future);

  assert.deepEqual(
    first.list().map((item) => item.id).sort(),
    ['first', 'second']
  );
});
