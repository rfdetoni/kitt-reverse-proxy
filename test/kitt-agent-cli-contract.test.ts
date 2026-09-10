import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import test from 'node:test';
import { startProxyServer } from '../src/proxy/server.js';
import { SessionManager } from '../src/runtime/session-manager.js';
import type {
  AppConfig,
  ChatExecutionOptions,
  ChatExecutionResult,
  ChatExecutor,
  JsonObject
} from '../src/types.js';

const config: AppConfig = {
  targetUrl: 'https://chatgpt.com/',
  model: 'chatgpt-web',
  ollamaUrl: 'http://127.0.0.1:11434/api/generate',
  host: '127.0.0.1',
  port: 0,
  captureTimeoutMs: 1_000,
  settleAfterCandidateMs: 100,
  responseSampleTimeoutMs: 1_000,
  ollamaTimeoutMs: 1_000,
  upstreamTimeoutMs: 1_000,
  uiResponseTimeoutMs: 1_000,
  uiSettleMs: 100,
  manualInterventionTimeoutMs: 1_000,
  maxSessions: 4,
  sessionIdleTimeoutMs: 120_000,
  logFormat: 'text',
  headed: false,
  cors: false,
  maxQueue: 8,
  minIntervalMs: 0,
  allowedEndpointHosts: [],
  followRedirects: false,
  provider: 'chatgpt',
  transport: 'ui',
  toolEnforcement: 'auto'
};

function completion(): ChatExecutionResult {
  return {
    completion: {
      id: 'contract-completion',
      object: 'chat.completion',
      created: 1,
      model: 'chatgpt-web',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_contract',
            type: 'function',
            function: { name: 'repo.read', arguments: '{"path":"README.md"}' }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    },
    deltas: []
  };
}

function executor(captured: ChatExecutionOptions[]): ChatExecutor {
  return {
    modelId: 'chatgpt-web',
    transport: 'ui',
    async execute(_body: JsonObject, options?: ChatExecutionOptions) {
      captured.push(options ?? {});
      return completion();
    },
    describe() {
      return {
        reasoning: {
          supported: true,
          dynamic: true,
          range: [0, 100],
          levels: ['instant', 'medium', 'high', 'extra_high']
        },
        toolCalling: 'protocol-emulated'
      };
    }
  };
}

async function close(server: Server, manager: SessionManager): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await manager.close();
}

async function fixture(): Promise<{
  manager: SessionManager;
  server: Server;
  baseUrl: string;
  captured: ChatExecutionOptions[];
}> {
  const captured: ChatExecutionOptions[] = [];
  const shared = executor(captured);
  const manager = new SessionManager({
    defaultExecutor: shared,
    provider: 'chatgpt',
    config,
    factory: async () => ({ executor: shared })
  });
  const server = await startProxyServer({ manager, config });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    manager,
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    captured
  };
}

test('publishes the exact compatibility surface consumed by KITT Agent CLI', async () => {
  const { manager, server, baseUrl } = await fixture();
  try {
    const response = await fetch(`${baseUrl}/v1/capabilities`);
    assert.equal(response.status, 200);
    const capabilities = await response.json() as any;
    const contract = capabilities.kitt_agent_cli;

    assert.equal(contract.protocol, 'openai-chat-completions');
    assert.equal(contract.native_tool_roundtrip, true);
    assert.equal(contract.session_header, 'X-Kitt-Session-Id');
    assert.equal(contract.request_id_header, 'X-Kitt-Request-Id');
    assert.equal(contract.reasoning_header, 'X-Kitt-Reasoning-Effort');
    assert.equal(contract.reasoning_supported, true);
    assert.deepEqual(contract.reasoning_range, [0, 100]);
    assert.equal(contract.parallel_tool_calls_recommended, false);
    assert.equal(contract.session_management.header, 'X-Kitt-Session-Id');
    assert.equal(contract.session_management.provider, 'chatgpt');
    assert.equal(contract.session_management.max, 4);
    assert.equal(contract.session_management.accepts_named_sessions, true);
    assert.equal(contract.session_management.idle_timeout_ms, 120_000);
  } finally {
    await close(server, manager);
  }
});

test('streams a native function call with stable session semantics and terminal DONE marker', async () => {
  const { manager, server, baseUrl, captured } = await fixture();
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Kitt-Session-Id': 'conversationA',
        'X-Kitt-Reasoning-Effort': '80'
      },
      body: JSON.stringify({
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: 'Inspect README' }],
        stream: true,
        parallel_tool_calls: false,
        tools: [{
          type: 'function',
          function: {
            name: 'repo.read',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path']
            }
          }
        }]
      })
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const requestId = response.headers.get('X-Kitt-Request-Id');
    assert(requestId && requestId.length > 0);

    const payload = await response.text();
    assert.match(payload, /data: \[DONE\]\n\n$/);
    const events = payload
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)) as any);
    const calls = events.flatMap((event) => event.choices?.[0]?.delta?.tool_calls ?? []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'call_contract');
    assert.equal(calls[0].function.name, 'repo.read');
    assert.equal(calls[0].function.arguments, '{"path":"README.md"}');
    assert.equal(events.at(-1)?.choices?.[0]?.finish_reason, 'tool_calls');
    assert.equal(captured.at(-1)?.reasoningEffort, 80);
    assert.equal(manager.list().some((session) => session.id === 'conversationA'), true);
  } finally {
    await close(server, manager);
  }
});

test('protocol validation failures are client errors, never internal server errors', async () => {
  const { manager, server, baseUrl } = await fixture();
  try {
    const cases = [
      ['/v1/chat/completions', { messages: [] }],
      ['/v1/responses', { input: [42] }],
      ['/v1/messages', { messages: [] }],
      ['/api/chat', { messages: [] }],
      ['/api/generate', { prompt: '' }]
    ] as const;

    for (const [path, body] of cases) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 400, path);
    }
  } finally {
    await close(server, manager);
  }
});
