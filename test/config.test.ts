import test from 'node:test';
import assert from 'node:assert/strict';
import { cliLaunchPresets, parseCliArgs } from '../src/config.js';

test('allow-endpoint-host accepts hostnames only', () => {
  const config = parseCliArgs(['https://example.com/chat', '--allow-endpoint-host', 'api.example.com']);
  if ('help' in config) throw new Error('unexpected help');
  assert.deepEqual(config.allowedEndpointHosts, ['api.example.com']);
  assert.throws(() => parseCliArgs(['https://example.com/chat', '--allow-endpoint-host', 'https://api.example.com']), /Host inválido/);
  assert.throws(() => parseCliArgs(['https://example.com/chat', '--allow-endpoint-host', '*.example.com']), /Host inválido/);
});

test('provider presets resolve target URL, UI transport and persistent profile', () => {
  const config = parseCliArgs(['chatgpt']);
  if ('help' in config) throw new Error('unexpected help');
  assert.equal(config.targetUrl, 'https://chatgpt.com/');
  assert.equal(config.provider, 'chatgpt');
  assert.equal(config.transport, 'ui');
  assert.equal(config.apiModel, 'chatgpt-web');
  assert.equal(config.browserMode, 'headed');
  assert.equal(config.headed, true);
  assert.match(config.userDataDir || '', /\.kitt-reverse-proxy[\\/]chatgpt$/);
});

test('optional start verb preserves preset convenience', () => {
  const config = parseCliArgs(['start', 'claude', '--headless']);
  if ('help' in config) throw new Error('unexpected help');
  assert.equal(config.targetUrl, 'https://claude.ai/new');
  assert.equal(config.provider, 'claude');
  assert.equal(config.headed, false);
  assert.equal(config.browserMode, 'headless');
});

test('explicit CLI options override preset-derived defaults', () => {
  const config = parseCliArgs(['gemini', '--transport', 'network', '--user-data-dir', '/tmp/kitt-profile']);
  if ('help' in config) throw new Error('unexpected help');
  assert.equal(config.transport, 'network');
  assert.equal(config.userDataDir, '/tmp/kitt-profile');
});

test('preset list is derived from supported browser providers', () => {
  assert.deepEqual(
    cliLaunchPresets().map((preset) => preset.id),
    ['chatgpt', 'claude', 'gemini', 'kimi', 'deepseek'],
  );
});

test('cdp-url flag configures remote debugging endpoint', () => {
  const config = parseCliArgs(['chatgpt', '--cdp-url', 'http://127.0.0.1:9222']);
  if ('help' in config) throw new Error('unexpected help');
  assert.equal(config.cdpUrl, 'http://127.0.0.1:9222/');
});

test('log level 2 and log file are parsed explicitly', () => {
  const config = parseCliArgs([
    'chatgpt',
    '--log-level', '2',
    '--log-content', 'full',
    '--log-file', '/tmp/kitt-reverse-proxy-trace.log'
  ]);
  if ('help' in config) throw new Error('unexpected help');
  assert.equal(config.logLevel, 2);
  assert.equal(config.logContent, 'full');
  assert.equal(config.logFile, '/tmp/kitt-reverse-proxy-trace.log');
});

test('invalid log level is rejected', () => {
  assert.throws(
    () => parseCliArgs(['chatgpt', '--log-level', '3']),
    /Log level inválido/
  );
});


test('invalid log content policy is rejected', () => {
  assert.throws(
    () => parseCliArgs(['chatgpt', '--log-content', 'everything']),
    /Log content inválido/
  );
});


test('external provider plugins are explicit and provider ids remain extensible', () => {
  const config = parseCliArgs([
    'https://chat.acme.test/',
    '--provider', 'acme',
    '--provider-plugin', './plugins/acme.mjs',
    '--provider-plugin', '@acme/kitt-provider'
  ]);
  if ('help' in config) throw new Error('unexpected help');
  assert.equal(config.provider, 'acme');
  assert.deepEqual(config.providerPlugins, ['./plugins/acme.mjs', '@acme/kitt-provider']);
});

test('invalid external provider ids are rejected before plugin loading', () => {
  assert.throws(
    () => parseCliArgs(['https://example.com/', '--provider', 'bad provider']),
    /Provider inválido/
  );
});


test('hybrid read controls parse conservatively and DOM remains an explicit kill switch', () => {
  const config = parseCliArgs([
    'chatgpt',
    '--read-mode', 'dom',
    '--tap-match-timeout-ms', '2500',
    '--tap-first-byte-ms', '6000',
    '--tap-stall-ms', '3500',
    '--tap-max-bytes', '1048576',
    '--tap-breaker-threshold', '4',
    '--tap-breaker-cooldown-s', '90',
    '--tap-verify-turns', '5'
  ]);
  if ('help' in config) throw new Error('unexpected help');

  assert.equal(config.readMode, 'dom');
  assert.equal(config.tapMatchTimeoutMs, 2500);
  assert.equal(config.tapFirstByteMs, 6000);
  assert.equal(config.tapStallMs, 3500);
  assert.equal(config.tapMaxBytes, 1048576);
  assert.equal(config.tapBreakerThreshold, 4);
  assert.equal(config.tapBreakerCooldownMs, 90_000);
  assert.equal(config.tapVerifyTurns, 5);
  assert.throws(() => parseCliArgs(['chatgpt', '--read-mode', 'unsafe']), /Read mode inválido/);
});
