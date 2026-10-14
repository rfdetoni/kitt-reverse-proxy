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
