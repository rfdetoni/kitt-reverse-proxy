import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { startProxyServer } from '../src/proxy/server.js';
import { SessionManager } from '../src/runtime/session-manager.js';
import { ToolParseFailedError } from '../src/runtime/tool-response.js';
import { ProviderNoImageSupportError } from '../src/runtime/multimodal.js';
import type { AppConfig, ChatExecutor, JsonObject } from '../src/types.js';

function createMockExecutor(name: string, handler?: (body: JsonObject) => JsonObject | Promise<JsonObject>): ChatExecutor {
  return {
    modelId: name,
    transport: 'ui',
    async execute(body: JsonObject) {
      if (handler) {
        const res = await handler(body);
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

test('proxy server handles session header, request ID, metrics, errors and limits', async () => {
  let createdNamedCount = 0;
  const manager = new SessionManager({
    defaultExecutor: createMockExecutor('default-model'),
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(res1.status, 200);
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

    const resInvalidSess = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kitt-Session-Id': 'bad-session-id-with-dashes!'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(resInvalidSess.status, 400);

    const resLimit = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kitt-Session-Id': 'sess2'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi 2' }] })
    });
    assert.equal(resLimit.status, 429);
    const limitBody = await resLimit.json();
    assert.deepEqual(limitBody, { error: 'session_limit_exceeded' });

    const resAnthropicLimit = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kitt-Session-Id': 'sess3'
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi anthropic' }] })
    });
    assert.equal(resAnthropicLimit.status, 429);
    const anthropicLimitBody = await resAnthropicLimit.json();
    assert.deepEqual(anthropicLimitBody, { error: 'session_limit_exceeded' });

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

    const delNamed = await fetch(`${baseUrl}/v1/kitt/sessions/sess1`, { method: 'DELETE' });
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
