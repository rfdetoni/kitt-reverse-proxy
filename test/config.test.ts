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
  assert.match(config.userDataDir || '', /\.kitt-reverse-proxy[\\/]chatgpt$/);
});

test('optional start verb preserves preset convenience', () => {
  const config = parseCliArgs(['start', 'claude', '--headless']);
  if ('help' in config) throw new Error('unexpected help');
  assert.equal(config.targetUrl, 'https://claude.ai/new');
  assert.equal(config.provider, 'claude');
  assert.equal(config.headed, false);
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
