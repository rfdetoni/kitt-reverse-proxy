import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider } from '../src/providers/catalog.js';
import { sendUiPrompt } from '../src/runtime/ui-interaction.js';
import { UiAutomationError } from '../src/runtime/ui-errors.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';

// Regression: after kitt_runtime returned in the Linux RE guest, ChatGPT's
// rich composer contained 1696 characters for a 1695-character prompt.
function fixture(recovery: 'correct' | 'still-mutated' | 'reverts') {
  const prompt = 'Result from kitt_runtime: ' + 'x'.repeat(1669);
  assert.equal(prompt.length, 1695);
  let draft = '';
  let domWrites = 0;
  let fillWrites = 0;
  let sends = 0;
  let keyboardWrites = 0;
  let afterDomReads = 0;
  const input = {
    last() { return this; },
    count: async () => 1,
    isVisible: async () => true,
    evaluate: async (fn: unknown, payload?: unknown) => {
      const code = String(fn);
      if (code.includes('html.isContentEditable')) return true;
      if (code.includes('const { text, replaceRichText } = payload')) {
        const args = payload as { text: string; replaceRichText: boolean };
        assert.equal(args.replaceRichText, true);
        domWrites++;
        draft = args.text + (recovery === 'still-mutated' ? 'X' : '');
        afterDomReads = 0;
        return undefined;
      }
      if (code.includes('html.innerText') || code.includes('textContent')) {
        if (recovery === 'reverts' && domWrites && ++afterDomReads >= 2) {
          draft = prompt + 'X';
        }
        return draft;
      }
      return draft;
    },
    fill: async (value: string) => { fillWrites++; draft = value + 'X'; },
    focus: async () => {},
    click: async () => {},
    press: async () => {}
  };
  const absent = { last() { return this; }, count: async () => 0 };
  const send = {
    last() { return this; }, all() { return [this]; },
    count: async () => 1,
    isVisible: async () => true, isEnabled: async () => true,
    click: async () => { sends++; assert.equal(draft, prompt); draft = ''; }
  };
  const frame = {
    isDetached: () => false,
    locator: (selector: string) =>
      selector.startsWith('button[data-testid="send-button"]') ? send :
      selector.includes('contenteditable') ? input : absent,
    evaluate: async (_fn: unknown, arg: unknown) => Array.isArray(arg) ? false : []
  };
  const session = { page: {
    frames: () => [frame],
    keyboard: { insertText: async () => { keyboardWrites++; } }
  }} as unknown as LiveBrowserSession;
  return {
    prompt, session,
    stats: () => ({ domWrites, fillWrites, sends, keyboardWrites })
  };
}

test('1695-character tool continuation repairs exactly one extra character and sends once', async () => {
  const target = fixture('correct');
  await sendUiPrompt(target.session, detectProvider('https://chatgpt.com'),
    { manualInterventionTimeoutMs: 1000 } as AppConfig, target.prompt);
  assert.deepEqual(target.stats(), {
    domWrites: 1, fillWrites: 1, sends: 1, keyboardWrites: 0
  });
});

test('1695-character persistent mutation fails closed without keyboard retry or submission', async () => {
  const target = fixture('still-mutated');
  await assert.rejects(
    sendUiPrompt(target.session, detectProvider('https://chatgpt.com'),
      { manualInterventionTimeoutMs: 1000 } as AppConfig, target.prompt),
    (error: unknown) => error instanceof UiAutomationError && /não foi enviado/.test(error.message)
  );
  assert.deepEqual(target.stats(), {
    domWrites: 1, fillWrites: 1, sends: 0, keyboardWrites: 0
  });
});

test('reconciliation that later mutates the draft is rejected without submission', async () => {
  const target = fixture('reverts');
  await assert.rejects(
    sendUiPrompt(target.session, detectProvider('https://chatgpt.com'),
      { manualInterventionTimeoutMs: 1000 } as AppConfig, target.prompt),
    UiAutomationError
  );
  assert.equal(target.stats().sends, 0);
  assert.equal(target.stats().keyboardWrites, 0);
});
