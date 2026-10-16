import test from 'node:test';
import assert from 'node:assert/strict';
import {selectFreshRenderedFrameForRepair,selectCompletedAssistantContract} from '../src/runtime/ui-dom.js';
const old='Previous chat';
const before=[{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:old}];
const prompt='Inspect the installed package versions and current Git revision before editing any code, then explain the changes using one JSON response object only.';
const invalid='{"action":"final_response","tool":null,"tool_input":null,"content":{"items": [broken]},"reasoning_summary":"","loop":null}';

test('fresh malformed JSON is delivered for host repair after the baseline',()=>{
  assert.equal(selectFreshRenderedFrameForRepair([old+'\n'+invalid],before),invalid);
  assert.equal(selectCompletedAssistantContract([invalid],[]),undefined);
});
test('virtualized DOM requires a new submitted prompt boundary for repair',()=>{
  assert.equal(selectFreshRenderedFrameForRepair(['Replaced page\n'+prompt+'\n'+invalid],before,prompt),invalid);
  assert.equal(selectFreshRenderedFrameForRepair(['Replaced page\n'+prompt],before,prompt),undefined);
  assert.equal(selectFreshRenderedFrameForRepair([invalid],before,prompt),undefined);
});
test('repair rejects echoed, prior and competing JSON responses',()=>{
  assert.equal(selectFreshRenderedFrameForRepair([old],before,prompt),undefined);
  assert.equal(selectFreshRenderedFrameForRepair([invalid],[],invalid),undefined);
  assert.equal(selectFreshRenderedFrameForRepair(['Page\n'+prompt+'\n'+invalid],[...before,{selector:'old',frameIndex:0,count:1,text:invalid}],prompt),undefined);
  assert.equal(selectFreshRenderedFrameForRepair([old+'\n'+invalid+'\n'+invalid.replace('broken','other')],before),undefined);
});
test('stable truncated JSON is untrusted repair input, never completion',()=>{
  const truncated='{"action":"use_tool","tool":"kitt_runtime","tool_input":{"operation":"repo.list","arguments":';
  assert.equal(selectFreshRenderedFrameForRepair([old+'\n'+truncated],before),truncated);
  assert.equal(selectCompletedAssistantContract([truncated],[]),undefined);
});
test('valid JSON goes through strict completion rather than serialization repair',()=>{
  const valid=JSON.stringify({action:'use_tool',tool:'kitt_runtime',tool_input:{operation:'repo.list',arguments:{path:'.'}},content:null,reasoning_summary:'',loop:null});
  assert.equal(selectFreshRenderedFrameForRepair([old+'\n'+valid],before),undefined);
  assert.equal(selectCompletedAssistantContract([valid],before),valid);
});

test('explicit current-prompt boundary excludes unrelated JSON from old page history', () => {
  const current=JSON.stringify({action:'final_response',tool:null,tool_input:null,content:'current',reasoning_summary:'',loop:null});
  const oldFrame=JSON.stringify({action:'final_response',tool:null,tool_input:null,content:'old page',reasoning_summary:'',loop:null});
  assert.equal(selectCompletedAssistantContract(
    [oldFrame, 'Page\\n'+prompt+'\\n'+current], before, prompt
  ),current);
});

test('long prompt can be identified by its unchanged distinctive suffix', () => {
  const prefix=Array.from({length: 12}, (_, i) => 'originalintroduction'+i).join(' ');
  const suffix=Array.from({length: 12}, (_, i) => 'distinctiveconclusion'+i).join(' ');
  const sent=prefix+' '+suffix;
  const result=JSON.stringify({action:'final_response',tool:null,tool_input:null,content:'fresh',reasoning_summary:'',loop:null});
  assert.equal(selectCompletedAssistantContract(
    ['Reformatted introduction\\n'+suffix+'\\n'+result], before, sent
  ),result);
});

test('two conflicting frames inside the fresh region are still rejected', () => {
  const first=JSON.stringify({action:'final_response',tool:null,tool_input:null,content:'one',reasoning_summary:'',loop:null});
  const second=JSON.stringify({action:'final_response',tool:null,tool_input:null,content:'two',reasoning_summary:'',loop:null});
  assert.equal(selectCompletedAssistantContract(
    ['Header\\n'+prompt+'\\n'+first+'\\n'+second], before, prompt
  ),undefined);
});
