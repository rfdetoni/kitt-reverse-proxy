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

test('single-line reply in body is passed to host repair even without assistant DOM nodes or prompt-tail anchor', () => {
  const prompt = 'Please enumerate exact dependencies in a long structured plan, and include an example:\\nK2 F\\nitems[1]:\\n  -\\n    local_id: EXAMPLE\\nK2/END';
  const before = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Old reply that disappeared due to virtualization'}];
  const flat = 'K2 F items[2]:   -     local_id: T00     kind: task     prompt: Inspect environment     success_criteria[1]:       - Works   -     local_id: FINAL     kind: final K2/END';
  assert.equal(selectFreshRenderedFrameForRepair(['Page\\n' + prompt + '\\n' + flat],before,prompt),flat);
  // Another visible sample of the same body must not count as a second frame.
  assert.equal(selectFreshRenderedFrameForRepair([flat,'Sidebar\\n' + flat],before,prompt),flat);
});

test('single-line fallback never trusts echoed user examples, prior replies or competing frames', () => {
  const flat = 'K2 F items[1]:   -     local_id: T01     prompt: Read README     success_criteria[1]:       - Checks pass K2/END';
  const previous = [{selector:'[pre-submit-visible-text]',frameIndex:-1,count:1,text:'Old DOM\\n' + flat.replace(/\\s+/g,' ')}];
  assert.equal(selectFreshRenderedFrameForRepair(['Page\\n' + flat],previous,'new request'),undefined);
  assert.equal(selectFreshRenderedFrameForRepair(['Page\\n' + flat],[],'User quoted: ' + flat.replace(/ {2,}/g,' ')),undefined);
  assert.equal(selectFreshRenderedFrameForRepair(['Page\\n' + flat + '\\n' + flat.replace('T01','T02')],[],'new request'),undefined);
  assert.equal(selectFreshRenderedFrameForRepair(['Page\\nK2 F items[1]: - missing terminator'],[],'new request'),undefined);
});
