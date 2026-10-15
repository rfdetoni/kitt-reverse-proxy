import test from 'node:test';
import assert from 'node:assert/strict';
import {selectFreshRenderedFrameForRepair} from '../src/runtime/ui-dom.js';

test('rendered reply must not reuse a previous body', () => {
  const old = 'Old conversation body';
  const baseline = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:old}];
  assert.equal(selectFreshRenderedFrameForRepair([old],baseline,'new request'),undefined);
});

test('new malformed reply can be handed to validation without reusing the prompt', () => {
  const old = 'Previous chat';
  const previous = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:old}];
  const reply = 'K2 F\nitems[1]:\n malformed row\nK2/END';
  assert.equal(selectFreshRenderedFrameForRepair([old + '\n' + reply], previous), reply);
});


test('large prompt anchors a new flattened KAP reply after DOM virtualization', () => {
  const prompt = 'Identify each small verifiable task from the request, retain all dependencies, and return one complete structured KAP envelope with item ids and explicit validation criteria.';
  const before = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Old conversation no longer visible'}];
  const collapsed = 'K2 F items[2]: - local_id: T01 kind: task - local_id: FINAL kind: final K2/END';
  assert.equal(selectFreshRenderedFrameForRepair(['Replaced page\n'+prompt+'\n'+collapsed],before,prompt),collapsed);
  assert.equal(selectFreshRenderedFrameForRepair(['Replaced page\n'+prompt],before,prompt),undefined);
  assert.equal(selectFreshRenderedFrameForRepair(['Replaced page\n'+prompt+'\n'+collapsed],[
    ...before,{selector:'[prior-assistant-contract]',frameIndex:-1,count:1,text:collapsed}
  ],prompt),undefined);
});

test('fresh prompt-anchored malformed multiline KAP goes to host repair, not a stale replay', () => {
  const prompt = 'Inspect the installed package versions and current Git revision before editing any code, then explain the changes using one KAP structured reply only.';
  const invalid = 'K2 F\nitems[1]:\n malformed row\nK2/END';
  const before = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Previous body'}];
  assert.equal(selectFreshRenderedFrameForRepair(['Page changed\n'+prompt+'\n'+invalid],before,prompt),invalid);
  assert.equal(selectFreshRenderedFrameForRepair(['Page changed\n'+prompt+'\n'+invalid+'\n'+invalid],before,prompt),undefined);
});

test('single-line reply in body is passed to host repair without assistant DOM nodes', () => {
  const nl = String.fromCharCode(10);
  const prompt = [
    'Please enumerate exact dependencies in a long structured plan, example:',
    'K2 F', 'items[1]:', '  -', '    local_id: EXAMPLE', 'K2/END'
  ].join(nl);
  const before = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Old reply virtualized'}];
  const flat = 'K2 F items[2]:   -     local_id: T00     kind: task     prompt: Inspect environment     success_criteria[1]:       - Works   -     local_id: FINAL     kind: final K2/END';
  assert.equal(selectFreshRenderedFrameForRepair(['Page'+nl+prompt+nl+flat],before,prompt),flat);
  assert.equal(selectFreshRenderedFrameForRepair([flat,'Sidebar'+nl+flat],before,prompt),flat);
});

test('single-line fallback denies echoes, prior replies and competing frames', () => {
  const nl = String.fromCharCode(10);
  const flat = 'K2 F items[1]:   -     local_id: T01     prompt: Read README     success_criteria[1]:       - Checks pass K2/END';
  const previous = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Old DOM'+nl+flat.replace(/\s+/g,' ')}];
  assert.equal(selectFreshRenderedFrameForRepair(['Page'+nl+flat],previous,'new request'),undefined);
  assert.equal(selectFreshRenderedFrameForRepair(['Page'+nl+flat],[],'User quoted: ' + flat.replace(/ {2,}/g,' ')),undefined);
  assert.equal(selectFreshRenderedFrameForRepair(['Page'+nl+flat+nl+flat.replace('T01','T02')],[],'new request'),undefined);
  assert.equal(selectFreshRenderedFrameForRepair(['Page'+nl+'K2 F items[1]: - missing terminator'],[],'new request'),undefined);
});


test('invalid tagged compact response reaches host repair, excluding prompt examples', () => {
  const slash = String.fromCharCode(92);
  const invalid = 'K2 F @json: {"items":[{"paths":["src/' + slash + '_init.py"]}]}  K2/END';
  const prompt = 'Produce task items, example K2 F @json: {"items":[{"local_id":"EXAMPLE"}]} K2/END';
  const before = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Previous visible page'}];
  assert.equal(selectFreshRenderedFrameForRepair(['Page\n' + prompt + '\n' + invalid],before,prompt),invalid);
  assert.equal(selectFreshRenderedFrameForRepair([invalid],[],invalid),undefined);
});

test('fresh flattened tool example with UI chrome reaches repair only after a new prompt', () => {
  const tool = 'K2 T kitt_runtime\noperation: repo.list\narguments:\n  path: .\nK2/END';
  const prompt = 'Inspect the workspace. Example:\n' + tool + '\n' +
    'Use only operations actually listed in the current tool catalog and return one complete action for the host to execute and verify.';
  const flat = tool.replace(/\s+/g,' ');
  const before = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Old answer'}];
  assert.equal(selectFreshRenderedFrameForRepair(['Page\n' + prompt],before,prompt),undefined);
  assert.equal(selectFreshRenderedFrameForRepair(['Page\n' + prompt + '\nChatGPT said:\n' + flat + '\nCopy'],before,prompt),flat);
});
