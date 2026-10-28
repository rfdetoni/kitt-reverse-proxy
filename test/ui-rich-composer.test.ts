import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider } from '../src/providers/catalog.js';
import { sendUiPrompt } from '../src/runtime/ui-interaction.js';
import { UiAutomationError } from '../src/runtime/ui-errors.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';

test('large rich editor uses verified DOM assignment without Playwright fill', async () => {
  const prompt = '# Windows API Observatory\n' + 'Win32\n'.repeat(10_000);
  let draft = '';
  let fillCalls = 0;
  let domCalls = 0;
  let submitCalls = 0;
  const editor = {
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    evaluate: async (fn: unknown, payload?: unknown) => {
      const code = String(fn);
      if (code.includes('html.isContentEditable')) return true;
      if (code.includes('return element instanceof HTMLTextAreaElement')) return false;
      if (code.includes('const { text, replaceRichText } = payload')) {
        domCalls++;
        const value = payload as { text: string; replaceRichText: boolean };
        assert.equal(value.replaceRichText, true);
        draft = value.text;
        return undefined;
      }
      return draft;
    },
    fill: async (value: string) => { fillCalls++; draft = value + 'EXTRA'; }
  };
  const none = {last() {return this;}, count: async () => 0};
  const button = {
    last() {return this;},
    all() {return [this];},
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => { submitCalls++; draft = ''; }
  };
  const frame = {
    isDetached: () => false,
    locator: (selector: string) =>
      selector.startsWith('button[data-testid="send-button"]') ? button
        : selector.includes('contenteditable') ? editor : none,
    evaluate: async (_fn: unknown, arg: unknown) => Array.isArray(arg) ? false : []
  };
  const session = {page: {frames: () => [frame]}} as unknown as LiveBrowserSession;
  await sendUiPrompt(session, detectProvider('https://chatgpt.com'),
    {manualInterventionTimeoutMs: 1000} as AppConfig, prompt);
  assert.equal(fillCalls, 0);
  assert.equal(domCalls, 1);
  assert.equal(submitCalls, 1);
});


test('medium rich editor bypasses slow fill and submits T00 once', async () => {
  const prompt = 'T00 — Preflight\n' + 'Inspect the workspace contracts safely.\n'.repeat(340);
  assert.ok(prompt.length > 8_192 && prompt.length < 16_384);
  let draft = '', fillCalls = 0, domCalls = 0, submitCalls = 0, keyboardCalls = 0;
  const editor = {
    last() { return this; }, count: async () => 1, isVisible: async () => true,
    evaluate: async (fn: unknown, payload?: unknown) => {
      const code = String(fn);
      if (code.includes('html.isContentEditable')) return true;
      if (code.includes('const { text, replaceRichText } = payload')) {
        const value = payload as {text:string; replaceRichText:boolean};
        assert.equal(value.replaceRichText, true);
        draft = value.text;
        domCalls++;
        return;
      }
      return draft;
    },
    fill: async (value: string) => {fillCalls++; draft = value + 'XYZ';}
  };
  const none = {last() {return this;}, count: async () => 0};
  const button = {
    last() {return this;}, all() {return [this];}, count: async () => 1,
    isVisible: async () => true, isEnabled: async () => true,
    click: async () => {submitCalls++; assert.equal(draft, prompt); draft = '';}
  };
  const frame = {
    isDetached: () => false,
    locator: (selector: string) =>
      selector.startsWith('button[data-testid="send-button"]') ? button :
      selector.includes('contenteditable') ? editor : none,
    evaluate: async (_fn: unknown, arg: unknown) => Array.isArray(arg) ? false : []
  };
  const session = {page: {frames: () => [frame], keyboard: {
    insertText: async () => {keyboardCalls++;}
  }}} as unknown as LiveBrowserSession;
  await sendUiPrompt(session, detectProvider('https://chatgpt.com'),
    {manualInterventionTimeoutMs: 1000} as AppConfig, prompt);
  assert.equal(fillCalls,0);
  assert.equal(domCalls,1);
  assert.equal(submitCalls,1);
  assert.equal(keyboardCalls,0);
});

test('medium rich editor rejects mismatched direct DOM assignment without keyboard replay', async () => {
  const prompt = 'T00\n' + 'Record immutable environment facts.\n'.repeat(350);
  assert.ok(prompt.length > 8_192 && prompt.length < 16_384);
  let draft = '', domCalls = 0, sendCalls = 0, keyboardCalls = 0;
  const editor = {
    last() { return this; }, count: async () => 1, isVisible: async () => true,
    evaluate: async (fn: unknown, payload?: unknown) => {
      if (String(fn).includes('html.isContentEditable')) return true;
      if (String(fn).includes('const { text, replaceRichText } = payload')) {
        draft = (payload as {text: string}).text + 'XYZ';
        domCalls++;
        return;
      }
      return draft;
    },
    fill: async (value: string) => {draft = value + 'XYZ';}
  };
  const none = {last() {return this;}, count: async () => 0};
  const button = {
    last() {return this;}, all() {return [this];}, count: async () => 1,
    isVisible: async () => true, isEnabled: async () => true,
    click: async () => {sendCalls++;}
  };
  const frame = {
    isDetached: () => false,
    locator: (selector: string) =>
      selector.startsWith('button[data-testid="send-button"]') ? button :
      selector.includes('contenteditable') ? editor : none,
    evaluate: async (_fn: unknown, arg: unknown) => Array.isArray(arg) ? false : []
  };
  const session = {page: {frames: () => [frame], keyboard: {
    insertText: async () => {keyboardCalls++;}
  }}} as unknown as LiveBrowserSession;
  await assert.rejects(
    sendUiPrompt(session, detectProvider('https://chatgpt.com'),
      {manualInterventionTimeoutMs: 1000} as AppConfig, prompt),
    (error: unknown) => error instanceof UiAutomationError && /Falha ao preencher/.test(error.message)
  );
  assert.equal(domCalls,1);
  assert.equal(sendCalls,0);
  assert.equal(keyboardCalls,0);
});

test('rich editor times out on direct DOM write and never sends an unverified draft', async () => {
  const prompt = 'KITT tool output\n' + 'data '.repeat(3_000);
  let sends = 0;
  let fills = 0;
  let domCalls = 0;
  const editor = {
    last() { return this; }, count: async () => 1, isVisible: async () => true,
    evaluate: async (fn: unknown) => {
      const code = String(fn);
      if (code.includes('html.isContentEditable')) return true;
      if (code.includes('return element instanceof HTMLTextAreaElement')) return false;
      if (code.includes('const { text, replaceRichText } = payload')) {
        domCalls++;
        throw Object.assign(new Error('renderer busy'), { name: 'TimeoutError' });
      }
      return '';
    },
    fill: async () => { fills++; }
  };
  const absent = { last() { return this; }, count: async () => 0 };
  const frame = {
    isDetached: () => false,
    locator: (selector: string) =>
      selector.includes('contenteditable') ? editor : absent
  };
  const session = { page: { frames: () => [frame], keyboard: {
    insertText: async () => { sends++; }
  }}} as unknown as LiveBrowserSession;
  await assert.rejects(
    sendUiPrompt(session, detectProvider('https://chatgpt.com'),
      { manualInterventionTimeoutMs: 1000 } as AppConfig, prompt),
    (err: unknown) => err instanceof UiAutomationError && /Falha ao preencher/.test(err.message)
  );
  assert.equal(domCalls, 1);
  assert.equal(fills, 0);
  assert.equal(sends, 0);
});
