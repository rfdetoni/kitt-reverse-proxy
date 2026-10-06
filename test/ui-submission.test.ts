import test from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider } from '../src/providers/catalog.js';
import { sendUiPrompt } from '../src/runtime/ui-interaction.js';
import { UiAutomationError } from '../src/runtime/ui-errors.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';

test('UI submission requires acceptance, including ignored click/Enter and detached composer', async () => {
  const provider = detectProvider('https://gemini.google.com/app');
  const config = {manualInterventionTimeoutMs: 1_000} as AppConfig;
  await Promise.all(['ignored-click', 'ignored-enter', 'detached', 'cleared'].map(async (mode) => {
    let text = '';
    let submitted = false;
    let clicks = 0;
    let enters = 0;
    const input = {
      last() { return this; },
      count: async () => 1,
      isVisible: async () => true,
      fill: async (value: string) => { text = value; },
      focus: async () => {},
      press: async () => { enters++; submitted = true; },
      evaluate: async () => {
        if (mode === 'detached' && submitted) throw new Error('detached composer');
        return text;
      }
    };
    const button = {
      last() { return this; },
      count: async () => mode === 'ignored-enter' ? 0 : 1,
      isVisible: async () => true,
      isEnabled: async () => true,
      click: async () => { clicks++; submitted = true; if (mode === 'cleared') text = ''; }
    };
    const frame = {
      isDetached: () => false,
      locator: (selector: string) => selector.includes('contenteditable') ? input : button,
      evaluate: async (_fn: unknown, args: unknown) => Array.isArray(args) ? false : []
    };
    const session = {page: {frames: () => [frame]}} as unknown as LiveBrowserSession;
    const pending = sendUiPrompt(session, provider, config, 'Current task');
    if (mode === 'cleared') await pending;
    else await assert.rejects(pending, (error: unknown) => error instanceof UiAutomationError && /confirm/i.test(error.message));
    assert.equal(clicks, mode === 'ignored-enter' ? 0 : 1);
    assert.equal(enters, mode === 'ignored-enter' ? 1 : 0, 'never submit a second time after uncertain acceptance');
  }));
});
