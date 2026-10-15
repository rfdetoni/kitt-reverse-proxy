import test from 'node:test';
import assert from 'node:assert/strict';
import {detectProvider} from '../src/providers/catalog.js';
import {HybridUiResponseReader} from '../src/runtime/read/hybrid-reader.js';
import {awaitUiResponse} from '../src/runtime/ui-response-monitor.js';
import {jsonCandidatesFromRenderedText, selectCompletedAssistantContract,
  inspectCompletedAssistantContract} from '../src/runtime/ui-dom.js';
import type {UiTextSnapshot} from '../src/runtime/ui-dom.js';
import type {AppConfig, LiveBrowserSession} from '../src/types.js';
import type {Page} from 'playwright';

const complete = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"status\":\"done\"},\"reasoning_summary\":\"\",\"loop\":null}";
const former = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"status\":\"previous\"},\"reasoning_summary\":\"\",\"loop\":null}";
const wrong = 'K2 F\nstatus: broken';
const baseline: UiTextSnapshot[] = [
  {selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Old transcript\n'+former}
];

for (const url of ['https://chatgpt.com/', 'https://gemini.google.com/app']) {
  test('explicit dom mode on '+url+' starts no CDP observer and returns DOM JSON', async () => {
    let attempts = 0;
    const session = {
      page: {frames: () => []},
      context: {newCDPSession: async () => {
        attempts++;
        throw new Error('CDP tap should not be initialized');
      }}
    } as unknown as LiveBrowserSession;
    const config = {readMode:'dom',uiSettleMs:50} as AppConfig;
    const dom: typeof awaitUiResponse = async (_session, _provider, _config, prior, _prompt,
      _onDelta, _signal, _tap, requireJSON) => {
      assert.equal(requireJSON,true);
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
  assert.ok(jsonCandidatesFromRenderedText(displayed).includes(complete));
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

test('provider body fallback cannot reuse pre-submit JSON message', async () => {
  const page={frames:()=>[{
    isDetached:()=>false,
    evaluate:async()=>({count:0,structural:0,samples:['Page\n'+former]})
  }]} as unknown as Page;
  const result=await inspectCompletedAssistantContract(page,baseline,'Different request');
  assert.equal(result.text,undefined);
});


test('compact final returns from DOM when a long prompt already contains K2 examples', () => {
  const reply = "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"items\":[{\"local_id\":\"T00\",\"kind\":\"task\"},{\"local_id\":\"FINAL\",\"kind\":\"final\"}]},\"reasoning_summary\":\"\",\"loop\":null}";
  const prompt = 'Decompose the original request. '.repeat(2000) +
    "{\"action\":\"final_response\",\"tool\":null,\"tool_input\":null,\"content\":{\"items\":[{\"local_id\":\"EXAMPLE\"}]},\"reasoning_summary\":\"\",\"loop\":null}" +
    'Expand with additional task items as necessary. No code fences or prose.';
  assert.equal(selectCompletedAssistantContract(['Page\n' + prompt + '\n' + reply],baseline,prompt),reply);
  assert.equal(selectCompletedAssistantContract([reply],[],reply),undefined);
});

test('invalid compact JSON is not a completed valid contract', () => {
  const slash = String.fromCharCode(92);
  const invalid = 'K2 F @json: {"items":[{"paths":["src/' + slash + 'qinit.py"]}]} K2/END';
  assert.equal(selectCompletedAssistantContract([invalid],[],'new request'),undefined);
});


test('illegal escapes and duplicate JSON fields cannot complete from DOM', () => {
  const slash = String.fromCharCode(92);
  const valid = JSON.stringify({action:'final_response',tool:null,tool_input:null,content:{path:'src/__init__.py'},reasoning_summary:'',loop:null});
  const escaped = valid.replace('__init__',slash + '_init_');
  assert.equal(selectCompletedAssistantContract([escaped],[],'new request'),undefined);
  assert.equal(selectCompletedAssistantContract([valid.replace('"path":','"path":"other","path":')],[],'new request'),undefined);
});


test('fresh JSON tool response survives missing assistant roles and long prompt examples', async () => {
  const tool = "{\"action\":\"use_tool\",\"tool\":\"kitt_runtime\",\"tool_input\":{\"operation\":\"repo.read\",\"arguments\":{\"path\":\"README.md\"}},\"content\":null,\"reasoning_summary\":\"\",\"loop\":null}";
  const prompt = 'Read the repository, reply with only one tool action. Example:\n' + tool;
  const previous: UiTextSnapshot[] = [
    {selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Old assistant turn'}
  ];
  let rendered = prompt;
  const page = {frames: () => [{
    isDetached: () => false,
    evaluate: async (_fn: unknown) => (
      // First evaluate() reads assistant selectors; second reads the
      // mutation observer captured before the prompt was submitted.
      ++reads % 2 === 1
        ? {count:0,structural:0,samples:['Old assistant turn',rendered]}
        : [tool]
    )
  }]} as unknown as Page;
  let reads = 0;
  const observed = await inspectCompletedAssistantContract(page,previous,prompt);
  assert.equal(observed.text, undefined, 'an echoed tool example cannot become a fresh action');

  reads = 0;
  const separatePrompt = 'Inspect the current workspace without editing files.';
  rendered = separatePrompt;
  const fresh = await inspectCompletedAssistantContract(page,previous,separatePrompt);
  assert.equal(fresh.text, tool);
  assert.equal(fresh.mutationSamples,1);
});

test('JSON tool candidates reject echoed, prior and competing tool actions', () => {
  const a = "{\"action\":\"use_tool\",\"tool\":\"kitt_runtime\",\"tool_input\":{\"operation\":\"repo.read\",\"arguments\":{\"path\":\"README.md\"}},\"content\":null,\"reasoning_summary\":\"\",\"loop\":null}";
  const b = a.replace('README.md','LICENSE');
  assert.equal(selectCompletedAssistantContract([a],[],a),undefined);
  assert.equal(selectCompletedAssistantContract([a],[{selector:'[prior-assistant-contract]',frameIndex:-1,count:1,text:a}]),undefined);
  assert.equal(selectCompletedAssistantContract([a,b],[]),undefined);
  assert.equal(selectCompletedAssistantContract([a],[],'Inspect README'),a);
});

test('a new reply after the submitted prompt may repeat its tool example or prior action', () => {
  const tool = "{\"action\":\"use_tool\",\"tool\":\"kitt_runtime\",\"tool_input\":{\"operation\":\"repo.list\",\"arguments\":{\"path\":\".\"}},\"content\":null,\"reasoning_summary\":\"\",\"loop\":null}";
  const prompt = 'Inspect the current workspace. Example:\n' + tool + '\n' +
    'Use only operations actually listed in the current tool catalog and return one complete action for the host to execute and verify.';
  const previous = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Old answer\n' + tool}];
  assert.equal(selectCompletedAssistantContract(['Page\n' + prompt],previous,prompt),undefined);
  assert.equal(selectCompletedAssistantContract(['Page\n' + prompt + '\n' + tool],previous,prompt),tool);
  assert.equal(selectCompletedAssistantContract(['Page\n' + prompt + '\n' + tool + '\n' +
    tool.replace('"path":"."','"path":"src"')],previous,prompt),undefined);
  const oldPage = 'Old page\n' + prompt + '\n' + tool;
  const oldBaseline = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:oldPage}];
  assert.equal(selectCompletedAssistantContract([oldPage + '\nSidebar changed'],oldBaseline,prompt),undefined);
  assert.equal(selectCompletedAssistantContract([oldPage + '\n' + prompt + '\n' + tool],oldBaseline,prompt),tool);
  assert.equal(selectCompletedAssistantContract([prompt + '\n' + prompt + '\n' + tool],[],prompt),undefined);
});
