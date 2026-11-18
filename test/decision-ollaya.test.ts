import assert from 'node:assert/strict';
import test from 'node:test';
import { DecisionAssistant, decisionSettingsFromEnv, decisionAdvisoryMessage } from '../src/decision/ollaya.js';

const settings = { mode: 'assist' as const, url: 'http://127.0.0.1:11435', model: 'laya', timeoutMs: 1000 };

function mockFetch(data: unknown): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.preset, 'router');
    assert.equal(payload.model, 'laya');
    assert.deepEqual(Object.keys(payload.state), ['request']);
    return new Response(JSON.stringify(data), { status: 200 });
  }) as typeof fetch;
}

const decision = {
  answers: {
    domain: { choice: 'code', confidence: 0.9 },
    difficulty: { score: 2.5 },
    needs_tools: { noul: 0.9 },
    is_sensitive: { noul: 0.3 }
  },
  state_truncated: false
};

test('decision assistance preserves user messages and tool permissions', async () => {
  const client = new DecisionAssistant(settings, mockFetch(decision));
  const original = { messages: [{ role: 'user', content: 'Fix a Java bug' }], tools: [], model: 'chatgpt-web' };
  const prepared = await client.prepare(original);
  assert.equal(prepared.status, 'assisted');
  assert.equal(prepared.signals?.domain, 'code');
  assert.equal(prepared.signals?.needsTools, true);
  assert.deepEqual((prepared.body.messages as unknown[]).slice(1), original.messages);
  assert.deepEqual(prepared.body.tools, []);
  assert.equal(original.messages.length, 1);
});

test('strict agent contract keeps wire body intact for deferred post-validation guidance', async () => {
  const client = new DecisionAssistant(settings, mockFetch(decision));
  const body = { messages: [{ role: 'user', content: 'Fix this' }] };
  const prepared = await client.prepare(body, undefined, true);
  assert.equal(prepared.status, 'assisted');
  assert.equal(prepared.body, body);
  assert.ok(prepared.signals);
});

test('no new decision on tool continuations or excessively long inputs', async () => {
  const client = new DecisionAssistant(settings, (() => { throw new Error('must not call'); }) as typeof fetch);
  assert.equal((await client.prepare({ messages: [{ role: 'tool', content: 'result' }] })).status, 'skipped');
  assert.equal((await client.prepare({ messages: [{ role: 'user', content: 'x'.repeat(5000) }] })).status, 'skipped');
});

test('provider errors or malformed outputs never block the LLM', async () => {
  const client = new DecisionAssistant(settings, mockFetch({ answers: { domain: {} } }));
  const body = { messages: [{ role: 'user', content: 'Hello' }] };
  const prepared = await client.prepare(body);
  assert.equal(prepared.status, 'unavailable');
  assert.equal(prepared.body, body);
});

test('configuration rejects credentials and unbounded timeouts', () => {
  assert.throws(() => decisionSettingsFromEnv({ PROXY_DECISION_URL: 'http://user:password@localhost:11435' }));
  assert.throws(() => decisionSettingsFromEnv({ PROXY_DECISION_TIMEOUT_MS: '999999' }));
  assert.equal(decisionSettingsFromEnv({ PROXY_DECISION_MODE: 'shadow' }).mode, 'shadow');
});

test('decision advisory is bounded and cannot expand granted tools', () => {
  const note = decisionAdvisoryMessage({
    domain: 'code', difficulty: 2, needsTools: true, sensitive: false, confidence: 0.9
  });
  assert.match(note, /do not grant permission to use tools/);
  assert.match(note, /Domain: code/);
  assert.equal(note.includes('Fix this'), false);
});
