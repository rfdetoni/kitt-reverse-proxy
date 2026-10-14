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
