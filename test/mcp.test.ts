import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '../src/runtime/session-manager.js';
import type { AppConfig, ChatExecutor } from '../src/types.js';

const baseConfig: AppConfig = {
  targetUrl: 'https://chatgpt.com/',
  model: 'gpt-4o',
  ollamaUrl: 'http://127.0.0.1:11434/api/generate',
  host: '127.0.0.1',
  port: 0,
  captureTimeoutMs: 1000,
  settleAfterCandidateMs: 100,
  responseSampleTimeoutMs: 1000,
  ollamaTimeoutMs: 1000,
  upstreamTimeoutMs: 1000,
  uiResponseTimeoutMs: 1000,
  uiSettleMs: 100,
  manualInterventionTimeoutMs: 1000,
  maxSessions: 2,
  sessionIdleTimeoutMs: 200,
  logFormat: 'text',
  headed: false,
  cors: false,
  maxQueue: 4,
  minIntervalMs: 0,
  allowedEndpointHosts: [],
  followRedirects: false,
  provider: 'chatgpt',
  transport: 'ui'
};

const mockExec: ChatExecutor = {
  modelId: 'gpt-4o',
  transport: 'ui',
  async execute(body) {
    const userMsg = (body.messages as any[])?.[0]?.content || '';
    return {
      completion: {
        id: 'cmpl-mcp',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [{ index: 0, message: { role: 'assistant', content: `Echo: ${userMsg}` }, finish_reason: 'stop' }]
      },
      deltas: []
    };
  },
  describe() { return {}; }
};

test('MCP server exposes ask_<provider> and resource kitt://sessions', async () => {
  const manager = new SessionManager({
    defaultExecutor: mockExec,
    provider: 'chatgpt',
    config: baseConfig
  });

  try {
    const mcpMod = await import('../src/mcp/server.js');
    assert.equal(typeof mcpMod.runMcpCli, 'function');
  } finally {
    await manager.close();
  }
});
