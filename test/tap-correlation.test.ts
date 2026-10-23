import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CdpStreamTap } from '../src/runtime/read/tap-cdp.js';
import { TapStreamAdapter } from '../src/runtime/read/tap-adapter.js';
import { completedRawContract, selectContractResponseText, transportPayload } from '../src/runtime/read/contract-text.js';
import { decodeTextBody } from '../src/discovery/decoder.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';
import type { ProviderPreset } from '../src/providers/catalog.js';

test('cold JSON tap reconstructs text patches and continuations without promoting user echoes', () => {
  const tool = "{\"action\":\"use_tool\",\"tool\":\"kitt_runtime\",\"tool_input\":{\"operation\":\"repo.list\",\"arguments\":{\"path\":\".\"}},\"content\":null,\"reasoning_summary\":\"\",\"loop\":null}";
  const adapter = new TapStreamAdapter(undefined, true);
  adapter.matchedResponse('https://chatgpt.com/dynamic-response', 'POST', 'text/event-stream');
  const push = (value: unknown) => adapter.push(Buffer.from('data: ' + JSON.stringify(value) + '\n\n'));
  push({messages:[{role:'assistant',content:tool}],request:{content:tool}});
  assert.equal(adapter.completedContract(),undefined,'echoed conversation history is not the current answer');
  push({p:'',o:'add',v:{message:{author:{role:'user'},content:{parts:[tool]}}}});
  assert.equal(adapter.completedContract(),undefined);
  push({p:'/message/content/parts/0',o:'append',v:tool});
  assert.equal(adapter.completedContract(),undefined);
  push({p:'',o:'add',v:{message:{author:{role:'assistant'},content:{parts:['']}}}});
  push({p:'/message/content/parts/0',o:'append',v:tool.slice(0,24)});
  push({v:tool.slice(24,55)});
  assert.equal(adapter.completedContract(),undefined);
  push({o:'patch',v:[{p:'/message/content/parts/0',o:'append',v:tool.slice(55)}]});
  assert.equal(adapter.completedContract(),tool);
  assert.equal(adapter.verification(tool),undefined,'stateful $.v must never become a learned generic leaf');
});

test('patch completion excludes metadata and competing assistant frames', () => {
  const a = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"state\":\"done\"},\"reasoning_summary\":\"\",\"loop\":null}";
  const adapter = new TapStreamAdapter(undefined,true);
  adapter.matchedResponse('https://chatgpt.com/dynamic-response','POST','text/event-stream');
  const push = (value: unknown) => adapter.push(Buffer.from('data: '+JSON.stringify(value)+'\n\n'));
  push({p:'/message/metadata/text',o:'append',v:a});
  assert.equal(adapter.completedContract(),undefined);
  push({p:'/answer',o:'replace',v:a});
  assert.equal(adapter.completedContract(),a);
  push({p:'/text',o:'replace',v:a.replace('done','different')});
  assert.equal(adapter.completedContract(),undefined);
});

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

test('RPC positional JSON strings learn a source path without joining metadata or changing source', () => {
  const expected = JSON.stringify({action:'final_response',tool:null,tool_input:null,content:'    <div>ação 😀</div>\n\nline\nline  ',reasoning_summary:'',loop:null});
  const envelope = (text: string) => JSON.stringify([['transport', 'request-id', JSON.stringify([null, [['candidate-id', [text], 'metadata']]])]]);
  const wire = (text: string) => ")]}'\n" + Buffer.byteLength(envelope(text)) + '\n' + envelope(text) + '\n';
  const shadow = new TapStreamAdapter(undefined, true);
  shadow.matchedResponse('https://gemini.google.com/rpc/stream', 'POST', 'application/json');
  for (const byte of Buffer.from(wire(expected))) shadow.push(Uint8Array.of(byte));
  shadow.end();
  const verified = shadow.verification(expected);
  assert.ok(verified, 'must discover the individual answer inside the encoded positional envelope');
  const active = new TapStreamAdapter(verified.profile, true);
  active.matchedResponse('https://gemini.google.com/rpc/stream', 'POST', 'application/json');
  active.push(Buffer.from(wire(expected))); active.end();
  assert.equal(active.accumulatedText(), expected);
  assert.equal(active.verification(expected)?.text, expected);
  assert.equal(active.verification(expected.replace('ação', 'alterado')), undefined);
});

test('CDP correlates an omitted form body even when response and finish precede body retrieval', async () => {
  const prompt = 'CURRENT UNIQUE TASK\n' + 'literal source with "quotes" and \\slashes\n'.repeat(10);
  const form = new URLSearchParams({'f.req':JSON.stringify([null,JSON.stringify([[prompt]])])}).toString();
  const wire = 'data: ' + JSON.stringify({delta:'original answer'}) + '\n\n';
  let release!: (value: unknown) => void;
  let reads = 0;
  const pending = new Promise(resolve => {release=resolve;});
  const cdp = fakeCdp(async method => {
    if (method === 'Network.getRequestPostData') {reads++; return pending;}
    return method === 'Network.streamResourceContent' ? {bufferedData:Buffer.from(wire).toString('base64')} : {};
  });
  const {tap,profile} = fixtureTap(async () => cdp);
  await tap.initialize();
  const turn = tap.arm(prompt);
  try {
    cdp.emit('Network.requestWillBeSent',{requestId:'current',type:'fetch',request:{url:'https://chatgpt.com/backend-api/conversation',method:'POST',hasPostData:true,headers:{'content-type':'application/x-www-form-urlencoded'}}});
    response(cdp); cdp.emit('Network.loadingFinished',{requestId:'current'});
    release({postData:form});
    const adapter = new TapStreamAdapter(profile);
    const matched = [];
    for await (const event of turn.events()) {
      if (event.type==='matched') {matched.push(event.requestId);adapter.matchedResponse(event.url,event.method,event.contentType);}
      if (event.type==='chunk') adapter.push(event.bytes);
      if (event.type==='end') adapter.end();
      if (event.type==='error') assert.fail(event.reason);
    }
    assert.equal(reads,1); assert.deepEqual(matched,['current']); assert.equal(adapter.accumulatedText(),'original answer');
  } finally {release({});turn.cancel();await tap.detach();}
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

test('late CDP POST body retrieval cannot leak into a replacement turn', async () => {
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const cdp = fakeCdp(async method => method === 'Network.getRequestPostData' ? pending : {});
  const {tap} = fixtureTap(async () => cdp);
  await tap.initialize();
  const old = tap.arm('OLD REQUEST');
  try {
    cdp.emit('Network.requestWillBeSent', {requestId:'old',request:{url:'https://chatgpt.com/backend-api/conversation',method:'POST',hasPostData:true}});
    const next = tap.arm('CURRENT REQUEST');
    release({postData:JSON.stringify({content:'OLD REQUEST and CURRENT REQUEST'})});
    await new Promise(resolve => setImmediate(resolve));
    cdp.emit('Network.responseReceived', {requestId:'old',response:{url:'https://chatgpt.com/backend-api/conversation',status:200,mimeType:'text/event-stream'}});
    next.cancel();
    const events = [];
    for await (const event of next.events()) events.push(event);
    assert.deepEqual(events,[]);
  } finally { release({}); old.cancel(); await tap.detach(); }
});

test('tap retains whole JSON source in named reply fields and rejects unbounded RPC extraction', () => {
  const source = JSON.stringify({action:'final_response',content:'original source',tool:null,tool_input:null,reasoning_summary:'',loop:null});
  const named = new TapStreamAdapter(undefined,true);
  named.matchedResponse('https://chatgpt.com/backend-api/conversation','POST','text/event-stream');
  named.push(Buffer.from('data: '+JSON.stringify({delta:source})+'\n\n'));
  named.end();
  assert.equal(named.verification(source)?.profile.textPath,'$.delta');
  assert.equal(named.verification(source)?.profile.jsonStringPaths,undefined);
  const excessive = new TapStreamAdapter();
  excessive.matchedResponse('https://gemini.google.com/rpc/stream','POST','application/json');
  assert.throws(() => excessive.push(Buffer.from(JSON.stringify(Array(129).fill('metadata'))+'\n')),/limit/);
  const encoded = new TapStreamAdapter({endpointOrigin:'https://gemini.google.com',endpointPath:'/rpc/stream',method:'POST',contentType:'application/json',framing:'framed',jsonStringPaths:['$[0]'],textPath:'$[1]',textMode:'delta'});
  encoded.matchedResponse('https://gemini.google.com/rpc/stream','POST','application/json');
  assert.throws(() => encoded.push(Buffer.from(JSON.stringify(['invalid JSON'])+'\n')),/changed/);
});

test('named reply parts retain their ordered source while opaque tuples keep separate candidates', () => {
  const adapter = new TapStreamAdapter();
  adapter.matchedResponse('https://chatgpt.com/backend-api/conversation','POST','text/event-stream');
  adapter.push(Buffer.from('data: '+JSON.stringify({parts:['original ','source']})+'\n\n'));
  adapter.end();
  const learned = adapter.verification('original source');
  assert.equal(learned?.profile.textPath,'$.parts[*]');
  const active = new TapStreamAdapter(learned!.profile);
  active.matchedResponse('https://chatgpt.com/backend-api/conversation','POST','text/event-stream');
  active.push(Buffer.from('data: '+JSON.stringify({parts:['next ','source']})+'\n\n'));
  active.end();
  assert.equal(active.accumulatedText(),'next source');
});

test('a correlated complete JSON reply can be recovered only after tap trust', () => {
  const raw = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":\"Finished\",\"reasoning_summary\":\"\",\"loop\":null}";
  assert.equal(completedRawContract(raw, '', false), undefined);
  assert.equal(completedRawContract(raw, '', true), raw);
  assert.equal((transportPayload(raw) as { action: string }).action, 'final_response');
  assert.equal(completedRawContract(raw.slice(0,-1), '', true), undefined);
  const different = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":\"Different\",\"reasoning_summary\":\"\",\"loop\":null}";
  assert.throws(() => selectContractResponseText(different, raw, true), /ambiguous|different/i);
});

test('large prompt matches correlated POST whose JSON splits the user content', async () => {
  const prompt = 'START UNIQUE CORRELATION TOKEN' + ' a'.repeat(4_000) + ' END UNIQUE CORRELATION TOKEN';
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  const fragmentSize = 192;
  const middleStart = Math.floor((normalized.length - fragmentSize) / 2);
  const fragments = [
    normalized.slice(0, fragmentSize),
    normalized.slice(middleStart, middleStart + fragmentSize),
    normalized.slice(-fragmentSize)
  ];
  const wire = 'data: ' + JSON.stringify({ delta: 'matched-reply' }) + '\n\n';
  const cdp = fakeCdp(async method =>
    method === 'Network.streamResourceContent'
      ? { bufferedData: Buffer.from(wire).toString('base64') } : {});
  const { tap } = fixtureTap(async () => cdp);
  await tap.initialize();
  const turn = tap.arm(prompt);
  try {
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'current',
      type: 'fetch',
      request: {
        url: 'https://chatgpt.com/backend-api/conversation',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({ messages: fragments.map(content => ({ role: 'user', content })) })
      }
    });
    response(cdp);
    cdp.emit('Network.loadingFinished', { requestId: 'current' });
    const observed: string[] = [];
    for await (const event of turn.events()) {
      if (event.type === 'matched') observed.push(event.requestId);
      if (event.type === 'error') assert.fail(`${event.reason}: ${event.detail ?? ''}`);
    }
    assert.deepEqual(observed, ['current']);
  } finally { turn.cancel(); await tap.detach(); }
});

test('CDP contract reader accepts only complete compact JSON and rejects disagreement', () => {
  const compact = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":\"Done.\",\"reasoning_summary\":\"\",\"loop\":null}";
  assert.equal(completedRawContract(compact, '', true), compact);
  assert.equal(completedRawContract(compact.slice(0,-1), '', true), undefined);
  assert.equal((transportPayload(compact) as {action: string}).action, 'final_response');
  assert.throws(() => selectContractResponseText("{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":\"Changed.\",\"reasoning_summary\":\"\",\"loop\":null}", compact, true), /different valid contract/i);
});

test('long composer prompts split into adjacent request content parts still correlate', async () => {
  const cdp = fakeCdp(async method => method === 'Network.streamResourceContent'
    ? {bufferedData: Buffer.from('data: ' + JSON.stringify({delta: 'OK'}) + '\n\n').toString('base64')}
    : {});
  const {tap, profile} = fixtureTap(async () => cdp);
  const prompt = 'UNIQUE TASK START ' + 'middle text with separated content segments. '.repeat(25) + 'UNIQUE TASK END';
  const parts = prompt.match(/[\s\S]{1,83}/g)!;
  assert.ok(parts.length > 3);
  await tap.initialize();
  const turn = tap.arm(prompt);
  try {
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'current', type: 'fetch',
      request: {url: 'https://chatgpt.com/backend-api/conversation', method: 'POST',
        headers: {'content-type': 'application/json'},
        postData: JSON.stringify({messages: [{role: 'user', content: {parts}}]})}
    });
    response(cdp);
    cdp.emit('Network.loadingFinished', {requestId: 'current'});
    const adapter = new TapStreamAdapter(profile);
    const matched: string[] = [];
    for await (const event of turn.events()) {
      if (event.type === 'matched') { matched.push(event.requestId); adapter.matchedResponse(event.url, event.method, event.contentType); }
      if (event.type === 'chunk') adapter.push(event.bytes);
      if (event.type === 'end') adapter.end();
      if (event.type === 'error') assert.fail(event.reason);
    }
    assert.deepEqual(matched, ['current']);
    assert.equal(adapter.accumulatedText(), 'OK');
  } finally { turn.cancel(); await tap.detach(); }
});


test('a single segmented long-prompt anchor can correlate a uniquely scoped provider request', async () => {
  const cdp = fakeCdp(async method => method === 'Network.streamResourceContent'
    ? {bufferedData: Buffer.from('data: ' + JSON.stringify({delta:"{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"status\":\"done\"},\"reasoning_summary\":\"\",\"loop\":null}"}) + '\n\n').toString('base64')}
    : {});
  const {tap} = fixtureTap(async () => cdp);
  await tap.initialize();
  const prompt = 'CURRENT_20261014_' + 'head'.repeat(100) + 'middle'.repeat(110) + 'end'.repeat(110);
  const turn = tap.arm(prompt);
  try {
    const url = 'https://chatgpt.com/backend-api/conversation';
    // The WebChat transport carries only the first of three anchors after
    // segmentation, but a competing request never supplies that same anchor.
    cdp.emit('Network.requestWillBeSent', {requestId:'unique', type:'fetch',
      request:{url, method:'POST', headers:{'content-type':'application/json'},
        postData:JSON.stringify({messages:[{role:'user', content:prompt.slice(0, 192)}]})}});
    cdp.emit('Network.responseReceived', {requestId:'unique', response:{url,status:200,
      mimeType:'text/event-stream',headers:{'content-type':'text/event-stream'}}});
    cdp.emit('Network.loadingFinished', {requestId:'unique'});
    const events = [];
    for await (const event of turn.events()) events.push(event);
    assert.ok(events.some(event => event.type === 'matched' && event.requestId === 'unique'));
    assert.ok(events.some(event => event.type === 'end'));
  } finally { turn.cancel(); await tap.detach(); }
});

test('competing partially matched requests fail closed instead of racing the wrong answer', async () => {
  const cdp = fakeCdp();
  const {tap} = fixtureTap(async () => cdp);
  await tap.initialize();
  const prompt = 'CURRENT_20261014_' + 'head'.repeat(100) + 'middle'.repeat(110) + 'end'.repeat(110);
  const turn = tap.arm(prompt);
  const url = 'https://chatgpt.com/backend-api/conversation';
  try {
    for (const requestId of ['left', 'right']) {
      cdp.emit('Network.requestWillBeSent', {requestId, type:'fetch',
        request:{url,method:'POST',headers:{'content-type':'application/json'},
          postData: JSON.stringify({messages:[{role:'user',content:prompt.slice(0,192)}]})}});
      cdp.emit('Network.responseReceived', {requestId, response:{url,status:200,
        mimeType:'text/event-stream',headers:{'content-type':'text/event-stream'}}});
    }
    await new Promise(resolve => setTimeout(resolve, 620));
    turn.cancel();
    const events = [];
    for await (const event of turn.events()) events.push(event);
    assert.equal(events.some(event => event.type === 'matched'), false);
  } finally { turn.cancel(); await tap.detach(); }
});



test('recorded assistant action survives batched patches, escape presentation and metadata copies', () => {
  const action = readFileSync(new URL('../../test/fixtures/chatgpt-patch-action.json',import.meta.url),'utf8').trim();
  const adapter = new TapStreamAdapter(undefined,true);
  adapter.matchedResponse('https://chatgpt.com/dynamic-response','POST','text/event-stream');
  const push = (value: unknown) => adapter.push(Buffer.from('event: delta\ndata: '+JSON.stringify(value)+'\n\n'));
  const other = JSON.stringify({action:'final_response',tool:null,tool_input:null,content:'metadata is not an answer',reasoning_summary:'',loop:null});
  push({p:'',o:'add',v:{message:{id:'reasoning',author:{role:'assistant'},channel:'analysis',content:{content_type:'thoughts',thoughts:[{content:other}]}}}});
  assert.equal(adapter.completedContract(),undefined);
  push({p:'',o:'add',v:{message:{id:'final',author:{role:'assistant'},channel:'final',content:{parts:['<escape>'+action.slice(0,40)]}}}});
  push({v:[{p:'/message/content/parts/0',o:'append',v:action.slice(40,-24)},
    {p:'/message/metadata/model_dil_v2/fallbackMarkdown',o:'append',v:other}]});
  assert.equal(adapter.completedContract(),undefined,'an unfinished presentation wrapper is not a complete reply');
  push({v:[{p:'/message/content/parts/0',o:'append',v:action.slice(-24)+'</escape>'},
    {p:'/message/metadata/model_dil_v2/constants',o:'append',v:{'0':other}},
    {p:'/message/status',o:'replace',v:'finished_successfully'}]});
  assert.equal(adapter.completedContract(),action,'only ordered assistant message bytes may supply the action');
  push({p:'',o:'add',v:{message:{id:'competing',author:{role:'assistant'},channel:'final',content:{parts:[other]}}}});
  assert.equal(adapter.completedContract(),undefined,'two current-turn answers remain ambiguous');
});


test('provider-native tool arguments and non-final channels never complete a KITT response', () => {
  const adapter = new TapStreamAdapter(undefined,true);
  adapter.matchedResponse('https://chatgpt.com/current','POST','text/event-stream');
  const push = (value: unknown) => adapter.push(Buffer.from('data: '+JSON.stringify(value)+'\n\n'));
  const native = JSON.stringify({path:'/GitHub/link/get_repo',args:{repository_full_name:'owner/repo'}});
  push({p:'',o:'add',v:{message:{id:'native',author:{role:'assistant'},channel:null,recipient:'all',content:{parts:[]}}}});
  push({p:'/message/recipient',o:'replace',v:'functions.native_reader'});
  push({p:'/message/content/parts/0',o:'append',v:native});
  assert.equal(adapter.completedContract(),undefined);
  push({delta:native});
  assert.equal(adapter.completedContract(),undefined,'generic leaves cannot bypass an observed tool recipient');
  push({p:'',o:'add',v:{message:{id:'final',author:{role:'assistant'},channel:null,recipient:'all',content:{parts:[]}}}});
  push({p:'/message/channel',o:'replace',v:'analysis'});
  push({p:'/message/content/parts/0',o:'append',v:native});
  assert.equal(adapter.completedContract(),undefined);
  push({p:'',o:'add',v:{message:{id:'answer',author:{role:'assistant'},channel:'final',recipient:'all',content:{parts:['{"verdict":"OK","issues":[]}']}}}});
  assert.equal(adapter.completedContract(),'{"verdict":"OK","issues":[]}');
});


test('late recipient classification invalidates earlier generic JSON for cold and learned capture', () => {
  const profile = {endpointOrigin:'https://chatgpt.com',endpointPath:'/stream',method:'POST',
    contentType:'text/event-stream',framing:'sse' as const,textPath:'$.delta',textMode:'snapshot' as const};
  for (const selected of [undefined, profile]) {
    const adapter = new TapStreamAdapter(selected,true);
    adapter.matchedResponse('https://chatgpt.com/stream','POST','text/event-stream');
    const push = (value: unknown) => adapter.push(Buffer.from('data: '+JSON.stringify(value)+'\n\n'));
    push({message:{id:'native',author:{role:'assistant'},content:{parts:[]}}});
    push({delta:'{"path":"native-tool","args":{}}'});
    assert.equal(adapter.completedContract(),undefined);
    push({p:'/message/recipient',o:'replace',v:'functions.native_reader'});
    push({message:{id:'answer',author:{role:'assistant'},channel:'final',recipient:'all',content:{parts:[]}}});
    push({delta:'{"items":["actual answer"]}'});
    assert.equal(adapter.completedContract(),'{"items":["actual answer"]}');
  }
});


test('CDP correlates one user message split into typed text objects', async () => {
  const cdp = fakeCdp(async method => method === 'Network.streamResourceContent'
    ? {bufferedData: Buffer.from('data: ' + JSON.stringify({delta:'typed-parts-ok'}) + '\n\n').toString('base64')}
    : {});
  const {tap} = fixtureTap(async () => cdp);
  const prompt = 'CURRENT-ISOLATED-RE-TURN ' + 'bounded trusted text evidence '.repeat(35) + ' FINAL-RE-SENTINEL';
  const parts = prompt.match(/[\s\S]{1,71}/g)!.map(text => ({type:'text', text}));
  await tap.initialize();
  const turn = tap.arm(prompt);
  try {
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'typed-current', type: 'fetch',
      request: {url: 'https://chatgpt.com/backend-api/conversation',
        method: 'POST', headers: {'content-type':'application/json'},
        postData: JSON.stringify({messages: [
          {role:'user', content:{parts:[{type:'text',text:'unrelated old turn'}]}},
          {role:'user', content:{parts}}
        ]})}
    });
    cdp.emit('Network.responseReceived', {requestId:'typed-current',
      response:{url:'https://chatgpt.com/backend-api/conversation',
        status:200, mimeType:'text/event-stream',headers:{'content-type':'text/event-stream'}}});
    cdp.emit('Network.loadingFinished', {requestId:'typed-current'});
    const events = [];
    for await (const event of turn.events()) events.push(event);
    assert.ok(events.some(e => e.type === 'matched' && e.requestId === 'typed-current'));
    assert.ok(events.some(e => e.type === 'end'));
    assert.equal(events.some(e => e.type === 'error'),false);
  } finally {turn.cancel(); await tap.detach();}
});

test('CDP never joins typed text from separate role/message objects', async () => {
  const cdp = fakeCdp();
  const {tap} = fixtureTap(async () => cdp,{tapMatchTimeoutMs:80});
  const prompt = 'SECURE_USER_BEGIN_' + 'A'.repeat(340) + '_SECURE_USER_END';
  await tap.initialize();
  const turn = tap.arm(prompt);
  try {
    const url='https://chatgpt.com/backend-api/conversation';
    cdp.emit('Network.requestWillBeSent', {requestId:'cross-turn', type:'fetch',
      request:{url,method:'POST',headers:{'content-type':'application/json'},
        postData:JSON.stringify({messages:[
          {role:'assistant',content:{parts:[{type:'text',text:prompt.slice(0,180)}]}},
          {role:'user',content:{parts:[{type:'text',text:prompt.slice(180)}]}}
        ]})}});
    cdp.emit('Network.responseReceived',{requestId:'cross-turn',
      response:{url,status:200,mimeType:'text/event-stream',headers:{'content-type':'text/event-stream'}}});
    const events = [];
    for await (const event of turn.events()) events.push(event);
    assert.equal(events.some(e=>e.type==='matched'), false);
    assert.ok(events.some(e=>e.type==='error' && e.reason==='no_matching_request'));
  } finally {turn.cancel(); await tap.detach();}
});
