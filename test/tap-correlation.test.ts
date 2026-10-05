import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CdpStreamTap } from '../src/runtime/read/tap-cdp.js';
import { TapStreamAdapter } from '../src/runtime/read/tap-adapter.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';
import type { ProviderPreset } from '../src/providers/catalog.js';

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
    cdp.emit('Network.responseReceived',{requestId,response:{mimeType:'text/event-stream',headers:{'content-type':'text/event-stream'}}});
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
