import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider } from '../src/providers/catalog.js';
import { sendUiPrompt } from '../src/runtime/ui-interaction.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';

test('large native ChatGPT textarea uses one input event, not Playwright fill/keyboard replay', async () => {
  const prompt = 'Long request: ' + 'x'.repeat(65_000);
  let current = '';
  let submitted = false;
  let fillCalls = 0;
  let nativeWrites = 0;
  const editor = {
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    evaluate: async (fn: unknown, arg?: unknown) => {
      const code = String(fn);
      if (code.includes('html.isContentEditable')) return true;
      if (code.includes('element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement')
        && !code.includes('Object.getOwnPropertyDescriptor')) return true;
      if (code.includes('Object.getOwnPropertyDescriptor')) {
        nativeWrites += 1;
        current = String(arg);
        return;
      }
      if (code.includes('html.innerText')) return submitted ? '' : current;
      return current;
    },
    fill: async () => { fillCalls += 1; },
    focus: async () => {},
    press: async () => {}
  };
  const absent = { last() { return this; }, count: async () => 0 };
  const send = {
    last() { return this; },
    all() { return [this]; },
    count: async () => 1,
    isVisible: async () => true,
    isEnabled: async () => true,
    click: async () => { submitted = true; }
  };
  const frame = {
    isDetached: () => false,
    locator: (selector: string) =>
      selector.startsWith('button[data-testid="send-button"]') ? send
        : selector === 'textarea' || selector.startsWith('textarea:') ? editor
          : absent,
    evaluate: async (_fn: unknown, arg: unknown) => Array.isArray(arg) ? false : []
  };
  const session = {page: { frames: () => [frame] }} as unknown as LiveBrowserSession;
  await sendUiPrompt(session, detectProvider('https://chatgpt.com'),
    { manualInterventionTimeoutMs: 1000 } as AppConfig, prompt);
  assert.equal(fillCalls, 0);
  assert.equal(nativeWrites, 1);
  assert.equal(submitted, true);
});
