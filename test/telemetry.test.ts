import test from 'node:test';
import assert from 'node:assert/strict';
import { Telemetry } from '../src/util/telemetry.js';

test('telemetry exports JSON and prometheus counters', () => {
  const telemetry = new Telemetry();
  telemetry.recordRequest('chatgpt', '/v1/chat/completions', 200);
  telemetry.recordToolCall('chatgpt', 'read_file', 'success');
  telemetry.recordParseFailure('json');
  telemetry.setSessionsActive(2);
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.sessions_active, 2);
  assert.equal(snapshot.requests_total[0]?.value, 1);
  const text = telemetry.prometheus();
  assert.match(text, /requests_total\{/);
  assert.match(text, /sessions_active 2/);
});
