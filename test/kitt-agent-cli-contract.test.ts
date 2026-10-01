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
    assert.equal(contract.reasoning_header, null);
    assert.equal(contract.reasoning_supported, false);
    assert.equal(contract.reasoning_range, undefined);
    assert.deepEqual(contract.reasoning, { supported: false });
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

test('streams a native function call while ignoring legacy reasoning headers', async () => {
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
    assert.equal(captured.at(-1)?.reasoningEffort, undefined);
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


test('invalid model contract stays recoverable and preserves the named session', async () => {
  let attempts = 0;
  const failing: ChatExecutor = {
    modelId: 'chatgpt-web',
    transport: 'ui',
    async execute() {
      attempts += 1;
      return {
        completion: {
          id: `invalid-contract-${attempts}`,
          object: 'chat.completion',
          created: 1,
          model: 'chatgpt-web',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'I encountered an error doing what you asked. Could you try again?' },
            finish_reason: 'stop'
          }]
        },
        deltas: []
      };
    },
    describe() {
      return {
        reasoning: { supported: false },
        toolCalling: 'protocol-emulated'
      };
    }
  };
  const manager = new SessionManager({
    defaultExecutor: failing,
    provider: 'chatgpt',
    config,
    factory: async () => ({ executor: failing })
  });
  const server = await startProxyServer({ manager, config });
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Kitt-Agent-Contract': 'v2',
        'X-Kitt-Route': 'agent-loop',
        'X-Kitt-Session-Id': 'recoverableConversation'
      },
      body: JSON.stringify({
        model: 'chatgpt-web',
        messages: [{ role: 'user', content: 'Inspect the workspace and continue.' }],
        kitt_meta: { conversation_id: 'c', turn_id: 't', request_id: 'r', route: 'agent-loop' },
        kitt_context: { schema_version: 1, epoch: 't', segments: [{
          id: 'host', kind: 'OUTPUT_CONTRACT', source: 'host-execution', trust: 'TRUSTED', priority: 100, token_cost: 4,
          body_ref: { host_execution: { schema_version: 1, conversation_id: 'c', turn_id: 't', tool_call_count: 0,
            mutation_count: 0, verified_mutation_count: 0, discovery_observed: false, validation_observed: false, completion_ready: true } }
        }] },
        tools: [{
          type: 'function',
          function: {
            name: 'kitt_runtime',
            parameters: {
              type: 'object',
              properties: {
                operation: { type: 'string', enum: ['repo.list'] },
                arguments: { type: 'object' }
              },
              required: ['operation']
            }
          }
        }]
      })
    });

    assert.equal(response.status, 409);
    const payload = await response.json() as any;
    assert.equal(payload.error.code, 'agent_contract_invalid');
    assert.equal(payload.error.recoverable, true);
    assert.equal(payload.error.recovery_action, 'continue');
    assert.equal(attempts, 3);
    assert.equal(manager.list().some((session) => session.id === 'recoverableConversation'), true);
  } finally {
    await close(server, manager);
  }
});
