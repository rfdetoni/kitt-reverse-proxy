import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider } from '../src/providers/catalog.js';
import { sendUiPrompt } from '../src/runtime/ui-interaction.js';
import { UiAutomationError } from '../src/runtime/ui-errors.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';

test('large editor mismatch never triggers a second keyboard insertion', async () => {
  const prompt = 'X'.repeat(20_000);
  let draft = '';
  let keyboardWrites = 0;
  let fallbackInteractions = 0;
  const input = {
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    fill: async (value: string) => { draft = value + 'EXTRA'; },
    evaluate: async (fn: unknown) =>
      String(fn).includes('html.isContentEditable') ? true : draft,
    focus: async () => { fallbackInteractions += 1; },
    click: async () => { fallbackInteractions += 1; },
    press: async () => { fallbackInteractions += 1; }
  };
  const absent = { last() { return this; }, count: async () => 0 };
  const frame = {
    isDetached: () => false,
    locator: (selector: string) => selector.includes('contenteditable') ? input : absent
  };
  const session = { page: {
    frames: () => [frame],
    keyboard: { insertText: async () => { keyboardWrites += 1; } }
  } } as unknown as LiveBrowserSession;
  await assert.rejects(
    sendUiPrompt(session, detectProvider('https://chatgpt.com'), { manualInterventionTimeoutMs: 1000 } as AppConfig, prompt),
    (error: unknown) => error instanceof UiAutomationError && /Texto grande não foi redigitado/.test(error.message)
  );
  assert.equal(keyboardWrites, 0);
  assert.equal(fallbackInteractions, 0);
});
