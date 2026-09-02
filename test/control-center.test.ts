import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  controlCenterSection,
  stringSetting,
  numberSetting,
  boolSetting,
  stringListSetting
} from '../src/control-center.js';

test('controlCenterSection reads from KITT_CONTROL_CENTER_CONFIG overlay', () => {
  const tmp = join(tmpdir(), `kitt-proxy-test-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const configPath = join(tmp, 'overrides.json');
  process.env.KITT_CONTROL_CENTER_CONFIG = configPath;

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        schema_version: 1,
        revision: 2,
        components: {
          'reverse_proxy.runtime': {
            model: 'qwen2.5-coder:14b',
            port: 3001,
            headed: false,
            follow_redirects: true,
            api_key_env: 'MY_SECRET_VAR'
          }
        }
      })
    );

    const section = controlCenterSection('reverse_proxy.runtime');
    assert.equal(stringSetting(section, 'model'), 'qwen2.5-coder:14b');
    assert.equal(numberSetting(section, 'port'), 3001);
    assert.equal(boolSetting(section, 'headed'), false);
    assert.equal(boolSetting(section, 'follow_redirects'), true);
    assert.equal(stringSetting(section, 'api_key_env'), 'MY_SECRET_VAR');
  } finally {
    delete process.env.KITT_CONTROL_CENTER_CONFIG;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('controlCenterSection returns empty object when file not found', () => {
  process.env.KITT_CONTROL_CENTER_CONFIG = join(tmpdir(), 'non-existent-overrides.json');
  try {
    const section = controlCenterSection('reverse_proxy.runtime');
    assert.deepEqual(section, {});
  } finally {
    delete process.env.KITT_CONTROL_CENTER_CONFIG;
  }
});

test('controlCenterSection rejects wrong schema version', () => {
  const tmp = join(tmpdir(), `kitt-proxy-schema-test-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  const configPath = join(tmp, 'overrides.json');
  process.env.KITT_CONTROL_CENTER_CONFIG = configPath;

  try {
    writeFileSync(configPath, JSON.stringify({ schema_version: 99, components: {} }));
    assert.throws(() => controlCenterSection('reverse_proxy.runtime'), /Unsupported KITT Control Center schema/);
  } finally {
    delete process.env.KITT_CONTROL_CENTER_CONFIG;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('stringListSetting parses and sanitizes array of strings', () => {
  const valid = { allowed_endpoint_hosts: [' api.example.com ', 'host2.local', ''] };
  assert.deepEqual(stringListSetting(valid, 'allowed_endpoint_hosts'), ['api.example.com', 'host2.local']);

  const invalid = { allowed_endpoint_hosts: [123, 'valid.host'] };
  assert.equal(stringListSetting(invalid, 'allowed_endpoint_hosts'), undefined);

  const empty = { other_key: [] };
  assert.equal(stringListSetting(empty, 'allowed_endpoint_hosts'), undefined);
});
