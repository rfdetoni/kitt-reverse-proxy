import test from 'node:test';
import assert from 'node:assert/strict';
import {detectProvider} from '../src/providers/catalog.js';
import {HybridUiResponseReader} from '../src/runtime/read/hybrid-reader.js';
import {awaitUiResponse} from '../src/runtime/ui-response-monitor.js';
import {kapCandidatesFromRenderedText, selectCompletedAssistantContract,
  inspectCompletedAssistantContract} from '../src/runtime/ui-dom.js';
import type {UiTextSnapshot} from '../src/runtime/ui-dom.js';
import type {AppConfig, LiveBrowserSession} from '../src/types.js';
import type {Page} from 'playwright';

const complete = 'K2 F\nstatus: done\nK2/END';
const former = 'K2 F\nstatus: previous\nK2/END';
const wrong = 'K2 F\nstatus: broken';
const baseline: UiTextSnapshot[] = [
  {selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Old transcript\n'+former}
];

for (const url of ['https://chatgpt.com/', 'https://gemini.google.com/app']) {
  test('auto mode on '+url+' starts no CDP observer and returns DOM KAP', async () => {
    let attempts = 0;
    const session = {
      page: {frames: () => []},
      context: {newCDPSession: async () => {
        attempts++;
        throw new Error('CDP tap should not be initialized');
      }}
    } as unknown as LiveBrowserSession;
    const config = {readMode:'auto',uiSettleMs:50} as AppConfig;
    const dom = (async (_session, _provider, _config, prior, _prompt,
      _onDelta, _signal, _tap, requireKAP) => {
      assert.equal(requireKAP,true);
      assert.deepEqual(prior,baseline);
      return {text:complete,deltas:[],firstDeltaMs:3,durationMs:8};
    }) as typeof awaitUiResponse;
    const reader = new HybridUiResponseReader(session,detectProvider(url),config,dom);
    await reader.initialize();
    reader.arm('Current turn');
    const result = await reader.read(baseline,'Current turn',undefined,undefined,true);
    assert.equal(result.text,complete);
    assert.equal(result.readDiagnostics.source,'dom');
    assert.equal(result.readDiagnostics.tap_mode,'disabled');
    assert.equal(result.readDiagnostics.mode,'dom');
    assert.equal(attempts,0);
    await reader.reset();
    assert.equal(attempts,0);
  });
}

test('DOM framing extracts K2/END inside rich markdown with chrome around it', () => {
  const displayed = 'Gemini\nCopiar\n~~~\n'+complete+'\n~~~\nShare\n';
  assert.ok(kapCandidatesFromRenderedText(displayed).includes(complete));
  assert.equal(selectCompletedAssistantContract([displayed],baseline,'Current request'),complete);
});

test('old response before new response is not mistaken for competing model output', () => {
  const displayed='Conversation\n'+former+'\nUser prompt\nAnswer\n'+complete+'\n';
  assert.equal(selectCompletedAssistantContract([displayed],baseline,'A different prompt'),complete);
});

test('invalid, partial, echoed and competing frames do not complete', () => {
  for(const sample of ['K2/END', wrong,
    'K2 F\nstatus: done\nK2/END\nK2 F\nstatus: invalid',
    'K2 F\nstatus: done\nK2/END\nK2 F\nstatus: changed\nK2/END']) {
    assert.equal(selectCompletedAssistantContract([sample],[]),undefined);
  }
  assert.equal(selectCompletedAssistantContract([complete],[],'Prefill\n'+complete),undefined);
  assert.equal(selectCompletedAssistantContract([former],baseline),undefined);
});

test('fresh Gemini DOM model-response sample can be accepted with no tap', async () => {
  const page={frames:()=>[{
    isDetached:()=>false,
    evaluate:async()=>({count:1,structural:0,samples:['Copy','Model response\n'+complete]})
  }]} as unknown as Page;
  const result=await inspectCompletedAssistantContract(page,baseline,'New request');
  assert.equal(result.text,complete);
  assert.equal(result.assistantNodes,1);
});

test('provider body fallback cannot reuse pre-submit KAP message', async () => {
  const page={frames:()=>[{
    isDetached:()=>false,
    evaluate:async()=>({count:0,structural:0,samples:['Page\n'+former]})
  }]} as unknown as Page;
  const result=await inspectCompletedAssistantContract(page,baseline,'Different request');
  assert.equal(result.text,undefined);
});
