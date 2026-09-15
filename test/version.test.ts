import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { SERVICE_VERSION } from '../src/version.js';

test('SERVICE_VERSION matches package.json', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  ) as { version?: unknown };

  assert.equal(typeof packageJson.version, 'string');
  assert.equal(SERVICE_VERSION, packageJson.version);
});
