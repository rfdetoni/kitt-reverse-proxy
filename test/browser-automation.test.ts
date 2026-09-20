import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BrowserAutomationInputError,
  BrowserAutomationSession,
  BrowserOriginDeniedError,
  normalizeBrowserOriginScope
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

  const clicked = await automation.execute(
    'click',
    { selector: '#save' },
    ['https://example.com']
  );
  assert.equal(clicked.action, 'click');

  const typed = await automation.execute(
    'type',
    {
      selector: '#name',
      text: 'KITT',
      submit: true
    },
    ['https://example.com']
  );
  assert.equal(typed.text_length, 4);
  assert.deepEqual(calls, ['click', 'fill:KITT', 'press:Enter']);
});


test('browser automation defaults to loopback and rejects external origins', async () => {
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
    automation.execute('open', { url: 'https://example.com/' }),
    BrowserOriginDeniedError
  );
  assert.equal(navigations, 0);

  await automation.execute('open', { url: 'http://127.0.0.1:4200/' });
  assert.equal(navigations, 1);
});

test('browser navigation guard aborts redirect outside the active origin scope', async () => {
  let routeHandler: any;
  const frame = {};
  let currentUrl = 'https://allowed.example/';
  const page = {
    isClosed: () => false,
    async route(_pattern: string, handler: any) { routeHandler = handler; },
    on() {},
    mainFrame: () => frame,
    async goto(url: string) { currentUrl = url; },
    url: () => currentUrl,
    async title() { return 'Allowed'; },
    async close() {},
    locator() { throw new Error('not used'); }
  } as any;
  const base = {
    context: { async newPage() { return page; } },
    page: {} as any,
    persistent: true,
    async close() {}
  } as any;
  const automation = await BrowserAutomationSession.create(
    base,
    ['https://allowed.example']
  );
  await automation.execute(
    'open',
    { url: 'https://allowed.example/' },
    ['https://allowed.example']
  );

  let aborted = false;
  let continued = false;
  await routeHandler({
    request: () => ({
      isNavigationRequest: () => true,
      frame: () => frame,
      url: () => 'https://evil.example/redirect'
    }),
    abort: async () => { aborted = true; },
    continue: async () => { continued = true; }
  });
  assert.equal(aborted, true);
  assert.equal(continued, false);
});


test('browser origin scope rejects URL credentials and does not broaden unspecified addresses', async () => {
  assert.throws(
    () => normalizeBrowserOriginScope(['https://user:secret@example.com']),
    BrowserAutomationInputError
  );

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
    automation.execute('open', { url: 'https://user:secret@example.com/' }, ['https://example.com']),
    BrowserAutomationInputError
  );
  await assert.rejects(
    automation.execute('open', { url: 'http://0.0.0.0:4200/' }, ['loopback']),
    BrowserOriginDeniedError
  );
  assert.equal(navigations, 0);
});

test('browser click blocks javascript and cross-origin activation before interaction', async () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,blocked', 'https://evil.example/path']) {
    let clicks = 0;
    const locator = {
      first() { return this; },
      async click() { clicks += 1; },
      async getAttribute(name: string) {
        if (name === 'href') return href;
        return null;
      },
      locator() {
        return {
          first() { return this; },
          async count() { return 0; },
          async getAttribute() { return null; }
        };
      }
    };
    const page = {
      isClosed: () => false,
      locator() { return locator; },
      url: () => 'https://allowed.example/',
      async title() { return 'Allowed'; },
      async close() {}
    } as any;
    const automation = new BrowserAutomationSession(page);

    await assert.rejects(
      automation.execute('click', { selector: '#danger' }, ['https://allowed.example']),
      BrowserOriginDeniedError
    );
    assert.equal(clicks, 0);
  }
});

test('browser submit preflights form targets before typing sensitive text', async () => {
  const calls: string[] = [];
  const locator = {
    first() { return this; },
    async fill(value: string) { calls.push(`fill:${value}`); },
    async press(value: string) { calls.push(`press:${value}`); },
    async pressSequentially(value: string) { calls.push(`seq:${value}`); },
    async getAttribute(name: string) {
      if (name === 'formaction') return 'javascript:steal()';
      return null;
    },
    locator() {
      return {
        first() { return this; },
        async count() { return 0; },
        async getAttribute() { return null; }
      };
    }
  };
  const page = {
    isClosed: () => false,
    locator() { return locator; },
    url: () => 'https://allowed.example/',
    async title() { return 'Allowed'; },
    async close() {}
  } as any;
  const automation = new BrowserAutomationSession(page);

  await assert.rejects(
    automation.execute(
      'type',
      { selector: '#secret', text: 'do-not-type', submit: true },
      ['https://allowed.example']
    ),
    BrowserOriginDeniedError
  );
  assert.deepEqual(calls, []);
});
