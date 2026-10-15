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
    const dom: typeof awaitUiResponse = async (_session, _provider, _config, prior, _prompt,
      _onDelta, _signal, _tap, requireKAP) => {
      assert.equal(requireKAP,true);
      assert.deepEqual(prior,baseline);
      return {text:complete,deltas:[],firstDeltaMs:3,durationMs:8};
    };
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


test('compact final returns from DOM when a long prompt already contains K2 examples', () => {
  const reply = 'K2 F @json: {"items":[{"local_id":"T00","kind":"task"},{"local_id":"FINAL","kind":"final"}]}  K2/END';
  const prompt = 'Decompose the original request. '.repeat(2000) +
    '\nK2 F @json: {"items":[{"local_id":"EXAMPLE"}]} K2/END\n' +
    'Expand with additional task items as necessary. No code fences or prose.';
  assert.equal(selectCompletedAssistantContract(['Page\n' + prompt + '\n' + reply],baseline,prompt),reply);
  assert.equal(selectCompletedAssistantContract([reply],[],reply),undefined);
});

test('invalid compact JSON is not a completed valid contract', () => {
  const slash = String.fromCharCode(92);
  const invalid = 'K2 F @json: {"items":[{"paths":["src/' + slash + 'qinit.py"]}]} K2/END';
  assert.equal(selectCompletedAssistantContract([invalid],[],'new request'),undefined);
});


test('Markdown-escaped underscore/star in compact final is normalized only after strict validation', () => {
  const slash = String.fromCharCode(92);
  const raw = 'K2 F @json: {"items":[{"paths":["src/' + slash + '_' + slash + '_init' +
    slash + '_' + slash + '_.py"],"pattern":"dlls/' + slash + '*.spec"}]} K2/END';
  const expected = 'K2 F @json: {"items":[{"paths":["src/__init__.py"],"pattern":"dlls/*.spec"}]} K2/END';
  assert.equal(selectCompletedAssistantContract([raw],[],'new request'),expected);
  // Do not reinterpret unrelated illegal JSON escapes or competing frames.
  assert.equal(selectCompletedAssistantContract([raw.replace(slash+'_',slash+'q')],[],'new request'),undefined);
  assert.equal(selectCompletedAssistantContract(['K2 F @json: {"x":1,"x":2} K2/END'],[],'new request'),undefined);
});


test('fresh K2 tool response survives missing assistant roles and long prompt examples', async () => {
  const tool = 'K2 T kitt_runtime\noperation: repo.read\narguments:\n  path: README.md\nK2/END';
  const prompt = 'Read the repository, reply with only one tool action. Example:\n' + tool;
  const previous: UiTextSnapshot[] = [
    {selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Old assistant turn'}
  ];
  const page = {frames: () => [{
    isDetached: () => false,
    evaluate: async (_fn: unknown) => (
      // First evaluate() reads assistant selectors; second reads the
      // mutation observer captured before the prompt was submitted.
      ++reads % 2 === 1
        ? {count:0,structural:0,samples:['Old assistant turn',prompt]}
        : [tool]
    )
  }]} as unknown as Page;
  let reads = 0;
  const observed = await inspectCompletedAssistantContract(page,previous,prompt);
  assert.equal(observed.text, undefined, 'an echoed tool example cannot become a fresh action');

  reads = 0;
  const separatePrompt = 'Inspect the current workspace without editing files.';
  const fresh = await inspectCompletedAssistantContract(page,previous,separatePrompt);
  assert.equal(fresh.text, tool);
  assert.equal(fresh.mutationSamples,1);
});

test('K2 tool candidates reject echoed, prior and competing tool actions', () => {
  const a = 'K2 T kitt_runtime\noperation: repo.read\narguments:\n  path: README.md\nK2/END';
  const b = a.replace('README.md','LICENSE');
  assert.equal(selectCompletedAssistantContract([a],[],a),undefined);
  assert.equal(selectCompletedAssistantContract([a],[{selector:'[prior-assistant-contract]',frameIndex:-1,count:1,text:a}]),undefined);
  assert.equal(selectCompletedAssistantContract([a,b],[]),undefined);
  assert.equal(selectCompletedAssistantContract([a],[],'Inspect README'),a);
});
