import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserAutomationInputError,
  BrowserAutomationSession
} from '../src/runtime/browser-automation.js';

test('browser automation rejects non-http navigation without touching the page', async () => {
  let navigations = 0;
  const page = {
    isClosed: () => false,
    async goto() { navigations += 1; },
    url: () => 'about:blank',
    async title() { return ''; },
    async close() {},
    locator() { throw new Error('not used'); }
  } as any;
  const automation = new BrowserAutomationSession(page);

  await assert.rejects(
    automation.execute('open', { url: 'file:///etc/passwd' }),
    BrowserAutomationInputError
  );
  assert.equal(navigations, 0);
});

test('browser automation click and type expose bounded declarative actions', async () => {
  const calls: string[] = [];
  const locator = {
    first() { return this; },
    async click() { calls.push('click'); },
    async fill(value: string) { calls.push(`fill:${value}`); },
    async press(value: string) { calls.push(`press:${value}`); },
    async pressSequentially(value: string) { calls.push(`seq:${value}`); }
  };
  const page = {
    isClosed: () => false,
    locator() { return locator; },
    url: () => 'https://example.com/',
    async title() { return 'Example'; },
    async close() {}
  } as any;
  const automation = new BrowserAutomationSession(page);

  const clicked = await automation.execute('click', { selector: '#save' });
  assert.equal(clicked.action, 'click');

  const typed = await automation.execute('type', {
    selector: '#name',
    text: 'KITT',
    submit: true
  });
  assert.equal(typed.text_length, 4);
  assert.deepEqual(calls, ['click', 'fill:KITT', 'press:Enter']);
});
