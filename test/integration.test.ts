import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { startProxyServer } from '../src/proxy/server.js';
import { SessionManager } from '../src/runtime/session-manager.js';
import { ToolParseFailedError } from '../src/runtime/tool-response.js';
import { ProviderNoImageSupportError } from '../src/runtime/multimodal.js';
import { UiChatExecutor } from '../src/runtime/ui-executor.js';
import { detectProvider } from '../src/providers/catalog.js';
import type { LiveBrowserSession } from '../src/types.js';
import type {
  AppConfig,
  ChatExecutionOptions,
  ChatExecutor,
  JsonObject
} from '../src/types.js';

function createMockExecutor(
  name: string,
  handler?: (
    body: JsonObject,
    options?: ChatExecutionOptions
  ) => JsonObject | Promise<JsonObject>
): ChatExecutor {
  return {
    modelId: name,
    transport: 'ui',
    async execute(body: JsonObject, options?: ChatExecutionOptions) {
      if (handler) {
        const res = await handler(body, options);
        return {
          completion: {
            id: 'mock-cmpl',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: name,
            choices: [{ index: 0, message: { role: 'assistant', content: 'mock output' }, finish_reason: 'stop' }],
            ...res
          },
          deltas: []
        };
      }
      return {
        completion: {
          id: 'mock-cmpl',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: name,
          choices: [{ index: 0, message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' }]
        },
        deltas: []
      };
    },
    describe() { return { mock: true }; }
  };
}

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

test('UI protocol retries premature final answers and completes an API tool round trip', async () => {
  const prompts: string[] = [];
  const answers = [
    'I inspected the project.',
    '<tool_call>{"name":"kitt_runtime","arguments":{"operation":"repo.read","arguments":{"path":"README.md"}}}</tool_call>',
    'README.md describes KITT.'
  ];
  const ui = new UiChatExecutor({
    page: { frames: () => [], evaluate: async () => [] }, persistent: false
  } as unknown as LiveBrowserSession, detectProvider('https://chatgpt.com/'), baseConfig);
  Object.assign(ui, {
    sendPrompt: async (prompt: string) => { prompts.push(prompt); },
    awaitResponse: async () => {
      const text = answers.shift();
      assert.notEqual(text, undefined, 'unexpected extra browser turn');
      return { text, snapshots: [text] };
    }
  });
  const manager = new SessionManager({ defaultExecutor: ui, provider: 'chatgpt', config: baseConfig });
  const server = await startProxyServer({ manager, config: baseConfig });
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const tools = [{ type: 'function', function: { name: 'kitt_runtime', parameters: {
    type: 'object', properties: { operation: { type: 'string' }, arguments: { type: 'object' } }, required: ['operation', 'arguments']
  } } }];
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'inspect this repository' }], tools, stream: true })
    });
    assert.equal(response.status, 200);
    const sse = await response.text();
    assert.doesNotMatch(sse, /<tool_call>|I inspected/);
    const chunks = sse.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6)));
    const call = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])[0];
    assert.equal(call.function.name, 'kitt_runtime');
    assert.equal(prompts.length, 2);
    assert.match(prompts[0]!, /visible assistant reply/);
    assert.match(prompts[1]!, /exploration tool/);
    const final = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions: 'Continue using the tool result.', tools,
        input: [{ type: 'function_call_output', call_id: call.id, output: 'KITT coding agent' }] })
    });
    assert.equal(final.status, 200);
    assert.equal((await final.json() as any).output_text, 'README.md describes KITT.');
    assert.match(prompts[2]!, /<tool_result name="kitt_runtime"/);
    assert.equal(answers.length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
});

test('proxy server handles session header, native reasoning, request ID, metrics, errors and LRU limits', async () => {
  let createdNamedCount = 0;
  let receivedReasoning: number | undefined;
  const manager = new SessionManager({
    defaultExecutor: createMockExecutor('default-model', (_body, options) => {
      receivedReasoning = options?.reasoningEffort;
      return {};
    }),
    provider: 'chatgpt',
    config: baseConfig,
    factory: async (id) => {
      createdNamedCount += 1;
      return { executor: createMockExecutor(`model-${id}`) };
    }
  });

  const server: Server = await startProxyServer({ manager, config: baseConfig });
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const res1 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kitt-Reasoning-Effort': '80'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(res1.status, 200);
    assert.equal(receivedReasoning, 80);
    const reqId1 = res1.headers.get('X-Kitt-Request-Id');
    assert(reqId1 && reqId1.length > 0);
    assert.equal(createdNamedCount, 0);

    const customReqId = 'req-test-12345';
    const res2 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kitt-Request-Id': customReqId,
        'X-Kitt-Session-Id': 'sess1'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi named' }] })
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get('X-Kitt-Request-Id'), customReqId);
    assert.equal(createdNamedCount, 1);

    const resInvalidReasoning = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kitt-Reasoning-Effort': '101'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'invalid reasoning' }] })
    });
    assert.equal(resInvalidReasoning.status, 400);
    assert.equal((await resInvalidReasoning.json() as any).error.code, 'invalid_reasoning_effort');

    const resInvalidSess = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kitt-Session-Id': 'bad-session-id-with-dashes!'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(resInvalidSess.status, 400);

    const resRecycled = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kitt-Session-Id': 'sess2'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi 2' }] })
    });
    assert.equal(resRecycled.status, 200);
    assert.equal(createdNamedCount, 2);
    assert.deepEqual(manager.list().map((session) => session.id), ['default', 'sess2']);

    const resAnthropicRecycled = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kitt-Session-Id': 'sess3'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi anthropic' }] })
    });
    assert.equal(resAnthropicRecycled.status, 200);
    assert.equal(createdNamedCount, 3);
    assert.deepEqual(manager.list().map((session) => session.id), ['default', 'sess3']);

    const metricsJsonRes = await fetch(`${baseUrl}/v1/kitt/metrics`);
    assert.equal(metricsJsonRes.status, 200);
    const metricsJson = (await metricsJsonRes.json()) as any;
    assert(metricsJson.requests_total && Array.isArray(metricsJson.requests_total));

    const metricsPromRes = await fetch(`${baseUrl}/v1/kitt/metrics`, {
      headers: { Accept: 'text/plain; version=0.0.4' }
    });
    assert.equal(metricsPromRes.status, 200);
    const metricsProm = await metricsPromRes.text();
    assert.match(metricsProm, /requests_total\{/);
    assert.match(metricsProm, /sessions_active \d+/);

    const sessionsRes = await fetch(`${baseUrl}/v1/kitt/sessions`);
    const sessionsList = (await sessionsRes.json()) as any;
    assert.equal(sessionsList.sessions.length, 2);

    const delDefault = await fetch(`${baseUrl}/v1/kitt/sessions/default`, { method: 'DELETE' });
    assert.equal(delDefault.status, 400);

    const delNamed = await fetch(`${baseUrl}/v1/kitt/sessions/sess3`, { method: 'DELETE' });
    assert.equal(delNamed.status, 200);
    assert.equal(manager.list().length, 1);

    await manager.execute('sess4', { messages: [{ role: 'user', content: 'test' }] });
    assert.equal(manager.list().length, 2);
    await new Promise((r) => setTimeout(r, 250));
    await manager.sweepIdle(Date.now() + 500);
    assert.equal(manager.list().length, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
});

test('proxy server handles structured output failed header, tool parse failed and image support error', async () => {
  let structuredFailed = false;
  let throwToolParse = false;
  let throwImageError = false;

  const mockExec: ChatExecutor = {
    modelId: 'test-model',
    transport: 'ui',
    async execute() {
      if (throwToolParse) {
        throw new ToolParseFailedError('Could not parse tool call from model output');
      }
      if (throwImageError) {
        throw new ProviderNoImageSupportError();
      }
      return {
        completion: {
          id: 'cmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'raw output' }, finish_reason: 'stop' }]
        },
        deltas: [],
        metadata: structuredFailed ? { structured_output: 'failed' } : undefined
      };
    },
    describe() { return {}; }
  };

  const manager = new SessionManager({
    defaultExecutor: mockExec,
    provider: 'chatgpt',
    config: baseConfig
  });

  const server: Server = await startProxyServer({ manager, config: baseConfig });
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    structuredFailed = true;
    const res1 = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'give me json' }],
        response_format: { type: 'json_object' }
      })
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('X-Kitt-Structured-Output'), 'failed');

    structuredFailed = false;
    throwToolParse = true;
    const resToolError = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'call tool' }] })
    });
    assert.equal(resToolError.status, 502);
    const toolErrBody = (await resToolError.json()) as any;
    assert.equal(toolErrBody.error?.code, 'tool_parse_failed');

    throwToolParse = false;
    throwImageError = true;
    const resImgError = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'look at image' }] })
    });
    assert.equal(resImgError.status, 400);
    const imgErrBody = (await resImgError.json()) as any;
    assert.equal(imgErrBody.error?.code, 'provider_no_image_support');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
});
