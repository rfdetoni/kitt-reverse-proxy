import test from 'node:test';
import assert from 'node:assert/strict';
import { TapStreamAdapter } from '../src/runtime/read/tap-adapter.js';
import { selectCompletedAssistantContract } from '../src/runtime/ui-dom.js';
import { AgentContractValidationError, assertAgentRepairContinuity,
  prepareAgentContractRequest, transformAgentContractCompletion } from '../src/runtime/agent-contract.js';
import type { OpenAiCompletion } from '../src/types.js';

const payload = { items: [{ local_id: 'T01', title: 'Read the workspace' }] };
const bare = JSON.stringify(payload);
const final = (content: unknown) => JSON.stringify({action:'final_response', tool:null,
  tool_input:null, content, reasoning_summary:'', loop:null});
const completion = (content: string): OpenAiCompletion => ({id:'capture',object:'chat.completion',
  created:1,model:'fixture',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]});

test('complete JSON from DOM and correlated assistant patches reaches host schema validation', () => {
  assert.equal(selectCompletedAssistantContract([bare], [], 'Inspect the current workspace'), bare);
  const adapter = new TapStreamAdapter(undefined, true);
  adapter.matchedResponse('https://chatgpt.com/dynamic-stream', 'POST', 'text/event-stream');
  const push = (value: unknown) => adapter.push(Buffer.from('data: '+JSON.stringify(value)+'\n\n'));
  push({p:'',o:'add',v:{message:{author:{role:'user'},content:{parts:[bare]}}}});
  assert.equal(adapter.completedContract(), undefined, 'user JSON is not an answer');
  push({p:'',o:'add',v:{message:{author:{role:'assistant'},content:{parts:['']}}}});
  push({p:'/message/content/parts/0',o:'append',v:bare.slice(0,12)});
  assert.equal(adapter.completedContract(), undefined);
  push({v:bare.slice(12)});
  assert.equal(adapter.completedContract(), bare);
  assert.equal(JSON.stringify(adapter.captureDiagnostics()).includes('Read the workspace'), false);
  assert.equal(adapter.captureDiagnostics(true).candidates.some(candidate => candidate.text === bare), true);
  const plan = prepareAgentContractRequest({messages:[{role:'user',content:'Plan this task'}]}, {sessionId:'capture-boundary'});
  assert.throws(() => transformAgentContractCompletion(completion(bare), plan),
    (error: unknown) => error instanceof AgentContractValidationError && error.kind === 'shape');
});

test('structured content repair may wrap exact data in final_response but cannot create a tool action', () => {
  const error = new AgentContractValidationError('Missing Agent envelope', 'shape');
  assert.doesNotThrow(() => assertAgentRepairContinuity(bare, final(payload), error));
  assert.throws(() => assertAgentRepairContinuity(bare, final({items:[]}), error), AgentContractValidationError);
  assert.throws(() => assertAgentRepairContinuity(bare, final({...payload, extra:'invented'}), error), AgentContractValidationError);
  const tool = JSON.stringify({action:'use_tool',tool:'kitt_runtime',tool_input:{operation:'repo.list',arguments:{}},content:null,reasoning_summary:'',loop:null});
  assert.throws(() => assertAgentRepairContinuity(bare, tool, error), AgentContractValidationError);
});

test('syntax-only capture still rejects prompt echoes, prior JSON and competing answers', () => {
  assert.equal(selectCompletedAssistantContract([bare], [], bare), undefined);
  assert.equal(selectCompletedAssistantContract([bare], [{selector:'old',frameIndex:0,count:1,text:bare}]), undefined);
  assert.equal(selectCompletedAssistantContract([bare, '{"items":[]}'], []), undefined);
  for (const invalid of [bare.slice(0,-1), '{"items":[],"items":[1]}', bare+'\n{"items":[]}', '{"items":NaN}']) {
    assert.equal(selectCompletedAssistantContract([invalid], []), undefined);
  }
});


test('rendered JSON prompt examples remain excluded when formatting changes token spacing', () => {
  const example = {api_id:'identifier_from_database',target_runtime:'wine',status:'UNTESTED',
    reason:'No verified differential probe for this scope',source_snapshot_ids:['actual-snapshot-id'],
    prerequisites:['Windows oracle runner available'],suggested_probe_ids:[],evidence_ids:[],blockers:[]};
  const pretty = JSON.stringify(example,null,2);
  const rendered = pretty.replaceAll('\n','');
  const prompt = 'Use this report shape as an example, never as actual evidence:\n'+pretty;
  assert.equal(selectCompletedAssistantContract([rendered],[],prompt),undefined);
  assert.equal(selectCompletedAssistantContract([rendered],
    [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:pretty}],'new task'),undefined);
  const distinct = JSON.stringify({...example,reason:'No verified  differential probe for this scope'});
  assert.equal(selectCompletedAssistantContract([distinct],[],prompt),distinct,
    'spaces inside string values are data and must not be normalized');
});
