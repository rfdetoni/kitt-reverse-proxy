import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CdpStreamTap } from '../src/runtime/read/tap-cdp.js';
import { TapStreamAdapter } from '../src/runtime/read/tap-adapter.js';
import { selectContractResponseText } from '../src/runtime/read/contract-text.js';
import { decodeTextBody } from '../src/discovery/decoder.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';
import type { ProviderPreset } from '../src/providers/catalog.js';

function fakeCdp(send: (method: string) => Promise<unknown> = async () => ({})) {
  const cdp = new EventEmitter() as EventEmitter & {
    send: (method: string) => Promise<unknown>;
    detach: () => Promise<void>;
    detached: number;
  };
  cdp.send = send;
  cdp.detached = 0;
  cdp.detach = async () => { cdp.detached += 1; };
  return cdp;
}

function fixtureTap(create: () => Promise<ReturnType<typeof fakeCdp>>, overrides: Partial<AppConfig> = {}) {
  const session = {context: {newCDPSession: create}, page: {}} as unknown as LiveBrowserSession;
  const config = {targetUrl: 'https://chatgpt.com', allowedEndpointHosts: [], readMode: 'auto', tapVerifyTurns: 1, ...overrides} as unknown as AppConfig;
  const tap = new CdpStreamTap(session, {id: 'chatgpt'} as ProviderPreset, config);
  const profile = {endpointOrigin: 'https://chatgpt.com', endpointPath: '/backend-api/conversation', method: 'POST', contentType: 'text/event-stream', framing: 'sse' as const, textPath: '$.delta', textMode: 'delta' as const};
  tap.recordVerified(profile);
  return {tap, profile};
}

function request(cdp: ReturnType<typeof fakeCdp>, prompt: string, url = 'https://chatgpt.com/backend-api/conversation', redirect = false) {
  cdp.emit('Network.requestWillBeSent', {requestId: 'current', type: 'fetch', ...(redirect ? {redirectResponse: {status: 307}} : {}), request: {url, method: 'POST', headers: {'content-type': 'application/json'}, postData: JSON.stringify({messages: [{content: prompt}]})}});
}

function response(cdp: ReturnType<typeof fakeCdp>, url = 'https://chatgpt.com/backend-api/conversation', status = 200) {
  cdp.emit('Network.responseReceived', {requestId: 'current', response: {url, status, mimeType: 'text/event-stream', headers: {'content-type': 'text/event-stream'}}});
}

test('failed CDP attachment releases the session and listeners before retry', async () => {
  const failed = fakeCdp(async () => { throw new Error('Network.enable failed'); });
  const healthy = fakeCdp();
  let creates = 0;
  const {tap} = fixtureTap(async () => ++creates === 1 ? failed : healthy);
  try {
    await tap.initialize();
    assert.equal(failed.detached, 1);
    assert.deepEqual(failed.eventNames(), []);
    assert.equal(tap.health().attached, false);
    await tap.initialize();
    assert.equal(creates, 2);
    assert.equal(tap.health().attached, true);
  } finally { await tap.detach(); }
});

test('concurrent initialization owns one CDP session and detach waits for attachment', async () => {
  const sessions: Array<ReturnType<typeof fakeCdp>> = [];
  const {tap} = fixtureTap(async () => { const cdp = fakeCdp(); sessions.push(cdp); return cdp; });
  try {
    await Promise.all([tap.initialize(), tap.initialize()]);
    assert.equal(sessions.length, 1);
    await tap.detach();
    await Promise.all([tap.initialize(), tap.detach()]);
    assert.equal(tap.health().attached, false);
    for (const cdp of sessions) {
      assert.equal(cdp.detached, 1);
      assert.deepEqual(cdp.eventNames(), []);
    }
  } finally { await tap.detach(); }
});

test('live CDP chunks wait behind buffered bytes while stream activation is pending', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const cdp = fakeCdp(async method => method === 'Network.streamResourceContent' ? pending : {});
  const {tap, profile} = fixtureTap(async () => cdp);
  await tap.initialize();
  const turn = tap.arm('ORDERED CURRENT TASK');
  try {
    request(cdp, 'ORDERED CURRENT TASK'); response(cdp);
    const first = 'data: ' + JSON.stringify({delta: '{"content":"'}) + '\n\n';
    const second = 'data: ' + JSON.stringify({delta: 'ação"}'}) + '\n\n';
    cdp.emit('Network.dataReceived', {requestId: 'current', data: Buffer.from(second).toString('base64')});
    cdp.emit('Network.loadingFinished', {requestId: 'current'});
    release({bufferedData: Buffer.from(first).toString('base64')});
    const adapter = new TapStreamAdapter(profile);
    for await (const event of turn.events()) {
      if (event.type === 'matched') adapter.matchedResponse(event.url, event.method, event.contentType);
      if (event.type === 'chunk') adapter.push(event.bytes);
      if (event.type === 'end') adapter.end();
      if (event.type === 'error') assert.fail(event.reason);
    }
    assert.equal(adapter.accumulatedText(), '{"content":"ação"}');
  } finally { turn.cancel(); await tap.detach(); }
});

test('pending live bytes obey the turn budget and cannot leak into the next turn', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const cdp = fakeCdp(async method => method === 'Network.streamResourceContent' ? pending : {});
  const {tap} = fixtureTap(async () => cdp, {tapMaxBytes: 1024});
  await tap.initialize();
  const turn = tap.arm('BYTE BUDGET TASK');
  try {
    request(cdp, 'BYTE BUDGET TASK'); response(cdp);
    cdp.emit('Network.dataReceived', {requestId: 'current', data: Buffer.alloc(1025, 'x').toString('base64')});
    const events = [];
    for await (const event of turn.events()) events.push(event);
    assert.ok(events.some(event => event.type === 'error' && event.reason === 'internal_error'));
    assert.equal(events.some(event => event.type === 'chunk'), false);
    const next = tap.arm('NEXT TASK');
    release({bufferedData: Buffer.from('old response').toString('base64')});
    await new Promise(resolve => setImmediate(resolve));
    next.cancel();
    const nextEvents = [];
    for await (const event of next.events()) nextEvents.push(event);
    assert.deepEqual(nextEvents, []);
  } finally { release({}); turn.cancel(); await tap.detach(); }
});

test('a correlated request cannot promote redirected or HTTP error bodies into raw responses', async t => {
  for (const mode of ['redirect', 'different-final-url', 'http-error']) {
    await t.test(mode, async () => {
      const cdp = fakeCdp(async method => method === 'Network.streamResourceContent' ? {bufferedData: Buffer.from('data: {"delta":"fabricated"}\n\n').toString('base64')} : {});
      const {tap} = fixtureTap(async () => cdp);
      await tap.initialize();
      const turn = tap.arm('CURRENT TASK');
      try {
        request(cdp, 'CURRENT TASK');
        if (mode === 'redirect') request(cdp, 'CURRENT TASK', 'https://untrusted.invalid/backend-api/conversation', true);
        response(cdp, mode === 'http-error' ? undefined : 'https://untrusted.invalid/backend-api/conversation', mode === 'http-error' ? 429 : 200);
        cdp.emit('Network.loadingFinished', {requestId: 'current'});
        const events = [];
        for await (const event of turn.events()) events.push(event);
        assert.ok(events.some(event => event.type === 'error'));
        assert.equal(events.some(event => event.type === 'chunk' || event.type === 'end'), false);
      } finally { turn.cancel(); await tap.detach(); }
    });
  }
});

test('SSE retains source whitespace and handles CR, LF and fragmented CRLF boundaries', () => {
  const pieces = ['    ', 'print("ação")  ', '\n', '    return 1  '];
  for (const newline of ['\n', '\r', '\r\n']) {
    const adapter = new TapStreamAdapter({endpointOrigin: 'https://chatgpt.com', endpointPath: '/stream', method: 'POST', contentType: 'text/event-stream', framing: 'sse', textPath: '$', textMode: 'delta'});
    adapter.matchedResponse('https://chatgpt.com/stream', 'POST', 'text/event-stream');
    const wire = pieces.map(piece => piece.split('\n').map(line => 'data: ' + line).join(newline) + newline + newline).join('');
    assert.deepEqual(decodeTextBody(wire, 'text/event-stream'), {eventStream: pieces});
    for (const byte of Buffer.from(wire)) adapter.push(Uint8Array.of(byte));
    adapter.end();
    assert.equal(adapter.accumulatedText(), pieces.join(''), JSON.stringify(newline));
  }
});

test('CDP tap correlates the full submitted prompt and decodes raw text without HTML', async () => {
  const cdp = new EventEmitter() as EventEmitter & {send:(method:string) => Promise<unknown>; detach:() => Promise<void>};
  cdp.detach = async () => {};
  const rawText = '{"content":"<div>ação</div>\\n"}';
  const wire = 'data: ' + JSON.stringify({delta:rawText}) + '\n\ndata: [DONE]\n\n';
  cdp.send = async method => method === 'Network.streamResourceContent' ? {bufferedData:Buffer.from(wire).toString('base64')} : {};
  const session = {context:{newCDPSession:async () => cdp},page:{}} as unknown as LiveBrowserSession;
  const config = {targetUrl:'https://chatgpt.com',allowedEndpointHosts:[],readMode:'auto',tapVerifyTurns:1} as unknown as AppConfig;
  const provider = {id:'chatgpt'} as ProviderPreset;
  const tap = new CdpStreamTap(session, provider, config); await tap.initialize();
  const profile = {endpointOrigin:'https://chatgpt.com',endpointPath:'/backend-api/conversation',method:'POST',contentType:'text/event-stream',framing:'sse' as const,textPath:'$.delta'};
  tap.recordVerified(profile);
  const suffix = 'shared repair instructions '.repeat(12);
  const turn = tap.arm('CURRENT UNIQUE TASK\n' + suffix);
  const emitRequest = (requestId:string, prompt:string): void => {
    cdp.emit('Network.requestWillBeSent',{requestId,type:'fetch',request:{url:'https://chatgpt.com/backend-api/conversation',method:'POST',headers:{'content-type':'application/json'},postData:JSON.stringify({messages:[{content:prompt}]})}});
    cdp.emit('Network.responseReceived',{requestId,response:{url:'https://chatgpt.com/backend-api/conversation',status:200,mimeType:'text/event-stream',headers:{'content-type':'text/event-stream'}}});
  };
  emitRequest('stale','OLD DIFFERENT TASK\n' + suffix);
  emitRequest('current','CURRENT UNIQUE TASK\n' + suffix);
  cdp.emit('Network.loadingFinished',{requestId:'current'});
  const adapter = new TapStreamAdapter(profile);
  const matched: string[] = [];
  for await (const event of turn.events()) {
    if (event.type === 'matched') {matched.push(event.requestId);adapter.matchedResponse(event.url,event.method,event.contentType);}
    if (event.type === 'chunk') adapter.push(event.bytes);
    if (event.type === 'end') {assert.equal(event.ok,true);adapter.end();}
    if (event.type === 'error') assert.fail(event.reason);
  }
  assert.deepEqual(matched,['current']);
  assert.equal(adapter.accumulatedText(),rawText);
  await tap.detach();
});

test('tap rejects malformed UTF-8 instead of replacing source characters', () => {
  const adapter = new TapStreamAdapter();
  assert.throws(() => adapter.push(Uint8Array.from([0xc3, 0x28])), /encoded data/);
});

test('tap profiles can learn JSON presentation differences without accepting changed content', () => {
  const adapter = new TapStreamAdapter(undefined, true);
  adapter.matchedResponse('https://chatgpt.com/backend-api/conversation','POST','text/event-stream');
  adapter.push(Buffer.from('data: ' + JSON.stringify({delta:'```json\n{"content":"<div>ação</div>"}\n```'}) + '\n\n'));
  adapter.end();
  assert.ok(adapter.verification('JSON\n{"content":"<div>ação</div>"}'));
  assert.equal(adapter.verification('JSON\n{"content":"ação"}'), undefined);
});

test('delta extraction preserves repeated source characters and lines', () => {
  const text = JSON.stringify({content:'aaaa\n\nline\nline\n'});
  const adapter = new TapStreamAdapter(undefined, true);
  adapter.matchedResponse('https://chatgpt.com/backend-api/conversation','POST','text/event-stream');
  for (const delta of text) adapter.push(Buffer.from('data: ' + JSON.stringify({delta}) + '\n\n'));
  adapter.end();
  const verified = adapter.verification(text);
  assert.equal(verified?.profile.textMode, 'delta');
  assert.equal(verified?.text, text);
});

test('snapshot extraction is learned separately and rejects non-monotonic replacements', () => {
  const text = '{"content":"aa"}';
  const adapter = new TapStreamAdapter(undefined, true);
  adapter.matchedResponse('https://chatgpt.com/backend-api/conversation','POST','text/event-stream');
  for (const snapshot of ['{"content":"a',text,text]) adapter.push(Buffer.from('data: ' + JSON.stringify({text:snapshot}) + '\n\n'));
  adapter.end();
  const verified = adapter.verification(text);
  assert.equal(verified?.profile.textMode, 'snapshot');
  const active = new TapStreamAdapter(verified!.profile, true);
  active.matchedResponse('https://chatgpt.com/backend-api/conversation','POST','text/event-stream');
  for (const snapshot of [text,'{"content":"changed"}']) active.push(Buffer.from('data: ' + JSON.stringify({text:snapshot}) + '\n\n'));
  active.end();
  assert.equal(active.accumulatedText(), '');
  assert.equal(active.verification('{"content":"changed"}'), undefined);
});

test('mode ambiguity cannot turn cumulative snapshots into fabricated source when DOM is damaged', () => {
  const base = {endpointOrigin:'https://chatgpt.com',endpointPath:'/backend-api/conversation',method:'POST',contentType:'text/event-stream',framing:'sse' as const,textPath:'$.text'};
  const expected = '{"content":"aa"}';
  for (const textMode of ['delta','snapshot'] as const) {
    const adapter = new TapStreamAdapter({...base,textMode}, true);
    adapter.matchedResponse('https://chatgpt.com/backend-api/conversation','POST','text/event-stream');
    for (const text of ['{"content":"a',expected]) adapter.push(Buffer.from('data: ' + JSON.stringify({text}) + '\n\n'));
    adapter.end();
    const read = () => selectContractResponseText('BROKEN DOM', adapter.accumulatedText(), true, adapter.accumulatedAlternativeText());
    if (textMode === 'delta') {
      assert.throws(read, /Delta and snapshot extraction/);
      assert.throws(() => selectContractResponseText(adapter.accumulatedText(), adapter.accumulatedText(), true, adapter.accumulatedAlternativeText()), /Delta and snapshot extraction/);
    }
    else assert.equal(read(), expected);
  }
});
