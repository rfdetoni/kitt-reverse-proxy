import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createProxyServer, startProxyServer } from '../src/proxy/server.js';
import { SessionManager } from '../src/runtime/session-manager.js';
import type { AppConfig, ChatExecutionOptions, ChatExecutor, JsonObject } from '../src/types.js';
import { ToolProtocolError } from '../src/mapping/tool-calling.js';
import { UiImageNotSupportedError } from '../src/runtime/multimodal.js';

const baseConfig: AppConfig = {
  targetUrl: 'https://chatgpt.com/',
  model: '',
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
  headed: false,
  cors: false,
  maxQueue: 4,
  minIntervalMs: 0,
  allowedEndpointHosts: [],
  followRedirects: false,
  maxSessions: 2,
  sessionIdleTimeoutMs: 60_000,
  logFormat: 'text',
  provider: 'chatgpt',
  transport: 'ui'
};

function createMockExecutor(
  modelId: string,
  handler?: (body: JsonObject, options?: ChatExecutionOptions) => JsonObject
): ChatExecutor {
  return {
    modelId,
    transport: 'ui',
    async execute(body, options) {
      const extras = handler?.(body, options) ?? {};
      return {
        completion: {
          id: 'mock',
          object: 'chat.completion',
          created: 1,
          model: modelId,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
        },
        deltas: [],
        metadata: extras
      };
    },
    describe() { return {}; }
  };
}

test('UI protocol retries premature final answers and completes an API tool round trip', async () => {
  const tools = [{ type: 'function', function: { name: 'kitt_runtime', description: 'runtime', parameters: { type: 'object' } } }];
  const answers: string[] = [];
  const prompts: string[] = [];
  let callCount = 0;
  const executor: ChatExecutor = {
    modelId: 'chatgpt-web',
    transport: 'ui',
    async execute(body, options) {
      const messages = body.messages as any[];
      const latest = messages[messages.length - 1];
      prompts.push(String(latest?.content ?? ''));
      callCount += 1;
      const content = callCount === 1
        ? 'I can answer this directly.'
        : callCount === 2
          ? '<tool_call>{"name":"kitt_runtime","arguments":{"operation":"repo.search","arguments":{"query":"README"}}}</tool_call>'
          : 'README.md describes KITT.';
      if (options?.onDelta) await options.onDelta(content);
      return {
        completion: {
          id: `mock-${callCount}`,
          object: 'chat.completion',
          created: 1,
          model: 'chatgpt-web',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
        },
        deltas: [content]
      };
    },
    describe() { return {}; }
  };
  const manager = new SessionManager({ defaultExecutor: executor, provider: 'chatgpt', config: baseConfig });
  const server: Server = await startProxyServer({ manager, config: baseConfig });
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const first = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Inspect the repository and answer.' }], tools, stream: true })
    });
    assert.equal(first.status, 200);
    const sse = await first.text();
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
    assert.match(metricsProm, /kitt_proxy_requests_total/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
});

test('proxy server handles structured output failed header, tool parse failed and image support error', async () => {
  const errorExecutor: ChatExecutor = {
    modelId: 'mock',
    transport: 'ui',
    async execute(body) {
      const marker = String((body.messages as any[])?.[0]?.content ?? '');
      if (marker.includes('toolparse')) throw new ToolProtocolError('Could not parse tool call from model output', 'tool_parse_failed');
      if (marker.includes('image')) throw new UiImageNotSupportedError();
      return {
        completion: {
          id: 'x', object: 'chat.completion', created: 1, model: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content: '{bad json' }, finish_reason: 'stop' }]
        },
        deltas: []
      };
    },
    describe() { return {}; }
  };
  const manager = new SessionManager({ defaultExecutor: errorExecutor, provider: 'chatgpt', config: baseConfig });
  const app = createProxyServer({ manager, config: baseConfig });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const toolParse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'toolparse' }], tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object' } } }] })
    });
    assert.equal(toolParse.status, 502);

    const image = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'image' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }] }] })
    });
    assert.equal(image.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await manager.close();
  }
});
