import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { HybridUiResponseReader } from '../src/runtime/read/hybrid-reader.js';
import { awaitUiResponse } from '../src/runtime/ui-response-monitor.js';
import { detectProvider } from '../src/providers/catalog.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';

const answer = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"state\":\"done\"},\"reasoning_summary\":\"\",\"loop\":null}";
const prompt = 'CURRENT UNIQUE WORKSPACE TASK';

function harness(dom: typeof awaitUiResponse, wire = answer, mode: 'auto' | 'tap' = 'tap') {
  const cdp = new EventEmitter() as EventEmitter & {
    send: (method: string) => Promise<unknown>;
    detach: () => Promise<void>;
  };
  cdp.send = async method => method === 'Network.streamResourceContent'
    ? { bufferedData: Buffer.from('data: ' + JSON.stringify({delta: wire}) + '\n\n')
        .toString('base64') }
    : {};
  cdp.detach = async () => {};
  const session = {
    page: { frames: () => [] },
    context: { newCDPSession: async () => cdp }
  } as unknown as LiveBrowserSession;
  const config = { targetUrl: 'https://chatgpt.com', readMode: mode,
    uiSettleMs: 750, tapVerifyTurns: 3, tapMatchTimeoutMs: 2000,
    allowedEndpointHosts: [] } as unknown as AppConfig;
  const reader = new HybridUiResponseReader(
    session, detectProvider('https://chatgpt.com'), config, dom);
  const push = () => {
    const url = 'https://chatgpt.com/backend-api/conversation';
    cdp.emit('Network.requestWillBeSent', { requestId: 'unique', type: 'fetch',
      request: { url, method: 'POST', headers: {'content-type': 'application/json'},
        postData: JSON.stringify({messages: [{content:prompt}]}) }});
    cdp.emit('Network.responseReceived', { requestId: 'unique',
      response: {url, status:200, mimeType:'text/event-stream',
        headers: {'content-type': 'text/event-stream'} } });
    cdp.emit('Network.loadingFinished', {requestId: 'unique'});
  };
  return { reader, push };
}

async function bounded<T>(promise: Promise<T>, ms = 2400): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('observer race blocked')), ms);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('auto CDP winner returns a complete K2 even when DOM never resolves', async () => {
  const dom = (async () => new Promise<never>(() => {})) as typeof awaitUiResponse;
  const { reader, push } = harness(dom, answer, 'auto');
  await reader.initialize();
  reader.arm(prompt);
  const outcome = reader.read([], prompt, undefined, undefined, true);
  push();
  const result = await bounded(outcome);
  assert.equal(result.text, answer);
  assert.equal(result.readDiagnostics.source, 'tap');
  // Cold tap is not permanently trusted until a separate DOM calibration.
  assert.equal(result.readDiagnostics.tap_verified, false);
});

test('independent DOM winner returns without waiting for any CDP match', async () => {
  const dom = (async () => ({text:answer, deltas:[], firstDeltaMs:2, durationMs:4})) as typeof awaitUiResponse;
  const {reader} = harness(dom, answer, 'auto');
  await reader.initialize();
  reader.arm(prompt);
  const result = await bounded(reader.read([], prompt, undefined, undefined, true), 750);
  assert.equal(result.text, answer);
  assert.equal(result.readDiagnostics.source, 'dom');
});

test('an incomplete tap frame cannot win over a valid DOM answer', async () => {
  const dom = (async () => {
    await new Promise(resolve => setTimeout(resolve, 180));
    return {text:answer, deltas:[], firstDeltaMs:100, durationMs:180};
  }) as typeof awaitUiResponse;
  const {reader, push} = harness(dom, 'K2 F\nstate: done');
  await reader.initialize();
  reader.arm(prompt);
  const promise = reader.read([], prompt, undefined, undefined, true);
  push();
  const result = await bounded(promise);
  assert.equal(result.text, answer);
  assert.equal(result.readDiagnostics.source, 'dom');
});

