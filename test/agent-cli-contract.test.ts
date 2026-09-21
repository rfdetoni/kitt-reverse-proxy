import test from 'node:test';
import assert from 'node:assert/strict';
import { kittAgentCliCapabilities } from '../src/proxy/capabilities.js';
import type { SessionManager } from '../src/runtime/session-manager.js';

function fakeManager(): SessionManager {
  return {
    browserAutomationSupported: () => true,
    capacity: () => ({
      provider: 'chatgpt',
      active: 1,
      named: 0,
      busy: 0,
      idle: 1,
      pending_creation: 0,
      recyclable_idle_named: 0,
      max: 4,
      idle_timeout_ms: 1_800_000,
      eviction: 'lru_idle',
      accepts_named_sessions: true,
      shutting_down: false
    })
  } as unknown as SessionManager;
}

test('agent-cli contract preserves the stable reverse-proxy integration surface', () => {
  const contract = kittAgentCliCapabilities(fakeManager());
  assert.equal(contract.proxy_contract_version, 2);
  assert.equal(contract.protocol, 'openai-chat-completions');
  assert.equal(contract.native_tool_roundtrip, true);
  assert.equal(contract.session_header, 'X-Kitt-Session-Id');
  assert.equal(contract.request_id_header, 'X-Kitt-Request-Id');
  assert.equal(contract.reasoning_supported, false);
  assert.equal(contract.reasoning_header, null);
  assert.equal(contract.parallel_tool_calls_recommended, false);

  const sessions = contract.session_management as Record<string, unknown>;
  assert.equal(sessions.header, 'X-Kitt-Session-Id');
  assert.equal(sessions.version, 1);
  const browser = contract.browser_automation as Record<string, unknown>;
  assert.equal(browser.origin_scope_enforced, true);
});
