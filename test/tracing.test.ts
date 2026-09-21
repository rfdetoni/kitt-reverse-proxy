import test from 'node:test';
import assert from 'node:assert/strict';
import { beginRequestTrace, flushTracing, traceSpan, traceparent } from '../src/observability/tracing.js';

test('OTLP tracing exports W3C-correlated root and child spans without blocking requests', async () => {
  const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: any }> = [];
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body || '{}'))
    });
    return new Response('', { status: 200 });
  }) as typeof fetch;

  try {
    await new Promise<void>((resolve, reject) => {
      beginRequestTrace('root', undefined, { 'test.root': true }, (context, finish) => {
        assert.match(traceparent(context), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
        void traceSpan('child', { 'test.child': 1 }, async () => 'ok')
          .then(() => { finish(); resolve(); })
          .catch((error) => { finish(error); reject(error); });
      });
    });
    await flushTracing();
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.url, 'http://127.0.0.1:4318/v1/traces');
    const spans = requests[0]!.body.resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans.length, 2);
    assert.deepEqual(new Set(spans.map((span: any) => span.name)), new Set(['root', 'child']));
    assert.equal(spans[0].traceId, spans[1].traceId);
  } finally {
    if (previousEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint;
    globalThis.fetch = previousFetch;
    await flushTracing();
  }
});
