import test from 'node:test';
import assert from 'node:assert/strict';
import {
  nativeChromeLaunchArgs,
  nextCdpPollDelay,
  systemChromeCandidates
} from '../src/runtime/native-chrome-session.js';

test('human Chrome bootstrap omits browser automation and sandbox-bypass flags', () => {
  const args = nativeChromeLaunchArgs(
    '/tmp/kitt-gemini-profile',
    49321,
    'https://accounts.google.com/ServiceLogin'
  );

  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--remote-debugging-port=49321'));
  assert.ok(args.includes('--user-data-dir=/tmp/kitt-gemini-profile'));
  assert.equal(args.some((arg) => arg === '--enable-automation'), false);
  assert.equal(args.some((arg) => arg === '--no-sandbox'), false);
  assert.equal(args.some((arg) => arg.includes('AutomationControlled')), false);
});

test('explicit Chrome executable has priority for human authentication', () => {
  const candidates = systemChromeCandidates('linux', {
    KITT_CHROME_BIN: '/custom/google-chrome',
    PATH: ''
  });
  assert.equal(candidates[0], '/custom/google-chrome');
});


test('CDP polling backs off while waiting and resets near the target', () => {
  let delay = 100;
  delay = nextCdpPollDelay(delay, false);
  assert.equal(delay, 160);
  delay = nextCdpPollDelay(delay, false);
  assert.equal(delay, 256);
  for (let index = 0; index < 10; index += 1) {
    delay = nextCdpPollDelay(delay, false);
  }
  assert.equal(delay, 1000);
  assert.equal(nextCdpPollDelay(delay, true), 100);
});
