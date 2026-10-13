import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider } from '../src/providers/catalog.js';
import { sendUiPrompt } from '../src/runtime/ui-interaction.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';

test('large rich editor autoformatting is recovered once with verified DOM assignment', async () => {
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
  assert.equal(fillCalls, 1);
  assert.equal(domCalls, 1);
  assert.equal(submitCalls, 1);
});
