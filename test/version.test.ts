import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { SERVICE_VERSION } from '../src/version.js';

test('SERVICE_VERSION and package lock metadata match package.json', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  ) as { version?: unknown };
  const packageLock = JSON.parse(
    readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8')
  ) as { version?: unknown; packages?: Record<string, { version?: unknown }> };

  assert.equal(typeof packageJson.version, 'string');
  assert.equal(SERVICE_VERSION, packageJson.version);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages?.['']?.version, packageJson.version);
});
