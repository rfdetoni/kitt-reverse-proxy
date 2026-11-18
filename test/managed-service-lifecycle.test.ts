import test from 'node:test';
import assert from 'node:assert/strict';

import { buildManagedProxyArgs, validateServiceModels } from '../src/control-plane/service-manager.js';
import { shutdownDrainTimeoutMs } from '../src/config.js';

test('shutdown drain timeout covers configured requests', () => {
  assert.equal(shutdownDrainTimeoutMs({ uiResponseTimeoutMs: 180000, upstreamTimeoutMs: 120000, manualInterventionTimeoutMs: 300000 }), 330000);
});

test('managed proxy launch forwards inherited logging and owner pid', () => {
  const args = buildManagedProxyArgs({
    cliPath: '/opt/kitt/dist/cli.js',
    target: {
      input: 'chatgpt',
      targetUrl: 'https://chatgpt.com/',
      provider: 'chatgpt',
      model: 'chatgpt-web'
    },
    host: '127.0.0.1',
    port: 3001,
    profileDirectory: '/tmp/profile',
    logLevel: 2,
    logContent: 'full',
    logFile: '/tmp/kitt/reverse-proxy-chatgpt-3001.log',
    ownerPid: 4242,
    ownerFingerprint: 'agent-fingerprint'
  });

  assert.deepEqual(args.slice(0, 3), [
    '/opt/kitt/dist/cli.js',
    'chatgpt',
    '--provider'
  ]);
  assert.equal(args[args.indexOf('--log-level') + 1], '2');
  assert.equal(args[args.indexOf('--log-content') + 1], 'full');
  assert.equal(
    args[args.indexOf('--log-file') + 1],
    '/tmp/kitt/reverse-proxy-chatgpt-3001.log'
  );
  assert.equal(args[args.indexOf('--owner-pid') + 1], '4242');
  assert.equal(
    args[args.indexOf('--owner-fingerprint') + 1],
    'agent-fingerprint'
  );
  assert.equal(args[args.indexOf('--user-data-dir') + 1], '/tmp/profile');
});

test('managed proxy launch does not invent ownership for manual services', () => {
  const args = buildManagedProxyArgs({
    cliPath: '/opt/kitt/dist/cli.js',
    target: {
      input: 'chatgpt',
      targetUrl: 'https://chatgpt.com/',
      provider: 'chatgpt',
      model: 'chatgpt-web'
    },
    host: '127.0.0.1',
    port: 3001,
    profileDirectory: '/tmp/profile',
    browserHostCdpPort: 9222,
    logLevel: 0,
    logContent: 'metadata',
    logFile: '/tmp/kitt/proxy.log'
  });

  assert.equal(args.includes('--owner-pid'), false);
  assert.equal(
    args[args.indexOf('--cdp-url') + 1],
    'http://127.0.0.1:9222'
  );
});

test('managed decision-model and temporary-chat options reject malformed values before restart', () => {
  validateServiceModels({
    decisionMode: 'assist', decisionModel: 'winnow:e4b',
    decisionUrl: 'http://127.0.0.1:11435', decisionTimeoutMs: 1200,
    temporaryChat: 'supported'
  });
  assert.throws(() => validateServiceModels({ decisionMode: 'invalid' as never }), /decisionMode/);
  assert.throws(() => validateServiceModels({ decisionModel: '--bad' }), /decisionModel/);
  assert.throws(() => validateServiceModels({ decisionUrl: 'http://user:pass@127.0.0.1:11435' }), /credentials/);
  assert.throws(() => validateServiceModels({ decisionTimeoutMs: 90000 }), /decisionTimeoutMs/);
  assert.throws(() => validateServiceModels({ temporaryChat: 'bad' as never }), /temporaryChat/);
});
