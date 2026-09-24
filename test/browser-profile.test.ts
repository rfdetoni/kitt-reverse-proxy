import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/types.js';
import {
  browserProfileDirectory,
  withPersistentBrowserProfile
} from '../src/util/browser-profile.js';

test('known provider URLs reuse the same managed profile as presets', () => {
  assert.equal(
    browserProfileDirectory('chatgpt', 'https://chatgpt.com/'),
    join(homedir(), '.kitt-reverse-proxy', 'chatgpt')
  );
});

test('UI fallback receives a persistent profile when none was configured', () => {
  const config = {
    targetUrl: 'https://chatgpt.com/'
  } as AppConfig;
  const resolved = withPersistentBrowserProfile(config, 'chatgpt');
  assert.notEqual(resolved, config);
  assert.equal(
    resolved.userDataDir,
    join(homedir(), '.kitt-reverse-proxy', 'chatgpt')
  );
});

test('explicit user profile and CDP browser remain authoritative', () => {
  const explicit = {
    targetUrl: 'https://chatgpt.com/',
    userDataDir: '/tmp/existing-kitt-profile'
  } as AppConfig;
  assert.equal(withPersistentBrowserProfile(explicit, 'chatgpt'), explicit);

  const cdp = {
    targetUrl: 'https://chatgpt.com/',
    cdpUrl: 'http://127.0.0.1:9222/'
  } as AppConfig;
  assert.equal(withPersistentBrowserProfile(cdp, 'chatgpt'), cdp);
});

test('generic sites receive isolated deterministic profiles per origin', () => {
  const a = browserProfileDirectory('generic', 'https://alpha.example/chat');
  const sameOrigin = browserProfileDirectory('generic', 'https://alpha.example/other');
  const b = browserProfileDirectory('generic', 'https://beta.example/chat');
  assert.equal(a, sameOrigin);
  assert.notEqual(a, b);
});
