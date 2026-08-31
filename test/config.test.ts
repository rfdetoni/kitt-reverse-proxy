import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../src/config.js';

test('allow-endpoint-host accepts hostnames only', () => {
  const config = parseCliArgs(['https://example.com/chat', '--allow-endpoint-host', 'api.example.com']);
  if ('help' in config) throw new Error('unexpected help');
  assert.deepEqual(config.allowedEndpointHosts, ['api.example.com']);
  assert.throws(() => parseCliArgs(['https://example.com/chat', '--allow-endpoint-host', 'https://api.example.com']), /Host inválido/);
  assert.throws(() => parseCliArgs(['https://example.com/chat', '--allow-endpoint-host', '*.example.com']), /Host inválido/);
});
