import test from 'node:test';
import assert from 'node:assert/strict';
import { sendUiPrompt } from '../src/runtime/ui-interaction.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';
import type { ProviderPreset } from '../src/providers/catalog.js';

for (const mode of ['button', 'enter', 'streaming', 'click-error'] as const) {
  test(`prompt submission is single-shot: ${mode}`, async () => {
    let clicks = 0;
    let enters = 0;
    const input = {
      last() { return this; },
      async count() { return 1; },
      async isVisible() { return true; },
      async focus() {},
      async click() {},
      async getAttribute() { return null; },
      async fill() {},
      async press(key: string) { if (key === 'Enter') enters++; },
      // The UI can retain the prompt after submission; never submit again.
      async evaluate() { return 'olá'; }
    };
    const send = {
      last() { return this; },
      async count() { return mode === 'enter' ? 0 : 1; },
      async isVisible() { return true; },
      async isEnabled() { return true; },
      async click() {
        clicks++;
        if (mode === 'click-error') throw new Error('click failed');
      }
    };
    const frame = {
      isDetached() { return false; },
      locator(selector: string) {
        if (selector === 'textarea') return input;
        assert.match(selector, /:not\(\[aria-label\*="stop" i\]\)/);
        return send;
      },
      async evaluate() { return mode === 'streaming'; }
    };
    const session = {
      page: {
        frames() { return [frame]; },
        keyboard: { async press(key: string) { if (key === 'Enter') enters++; } }
      }
    } as unknown as LiveBrowserSession;
    const provider = { ui: {
      inputSelectors: ['textarea'], sendSelectors: ['button'], streamingSelectors: ['.streaming']
    } } as unknown as ProviderPreset;
    const result = sendUiPrompt(session, provider, { manualInterventionTimeoutMs: 1000 } as AppConfig, 'olá');
    if (mode === 'click-error') await assert.rejects(result, /click failed/);
    else await result;
    assert.equal(clicks, mode === 'button' || mode === 'click-error' ? 1 : 0);
    assert.equal(enters, mode === 'enter' ? 1 : 0);
  });
}
