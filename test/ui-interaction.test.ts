import test from 'node:test';
import assert from 'node:assert/strict';
import { sendUiPrompt } from '../src/runtime/ui-interaction.js';
import type { AppConfig, LiveBrowserSession } from '../src/types.js';
import type { ProviderPreset } from '../src/providers/catalog.js';

for (const mode of ['button', 'enter', 'stale-streaming', 'click-error', 'typing-fallback'] as const) {
  test(`prompt submission is single-shot and observable: ${mode}`, async () => {
    let clicks = 0;
    let enters = 0;
    let composerText = '';

    const input = {
      last() { return this; },
      async count() { return 1; },
      async isVisible() { return true; },
      async focus() {},
      async click() {},
      async fill(value: string) {
        if (mode === 'typing-fallback') throw new Error('rich editor fill unsupported');
        composerText = value;
      },
      async press(key: string) {
        if (key === 'Backspace') composerText = '';
        if (key === 'Enter') {
          enters++;
          composerText = '';
        }
      },
      async evaluate() { return composerText; }
    };

    const send = {
      last() { return this; },
      async count() { return mode === 'enter' ? 0 : 1; },
      async isVisible() { return true; },
      async isEnabled() { return true; },
      async click() {
        clicks++;
        if (mode === 'click-error') throw new Error('click failed');
        composerText = '';
      }
    };

    const frame = {
      isDetached() { return false; },
      locator(selector: string) {
        if (selector === 'textarea') return input;
        assert.match(selector, /:not\(\[aria-label\*="stop" i\]\)/);
        return send;
      },
      async evaluate() { return mode === 'stale-streaming'; }
    };

    const session = {
      page: {
        frames() { return [frame]; },
        keyboard: {
          async insertText(value: string) { composerText += value; }
        }
      }
    } as unknown as LiveBrowserSession;

    const provider = { ui: {
      inputSelectors: ['textarea'],
      sendSelectors: ['button'],
      streamingSelectors: ['.streaming']
    } } as unknown as ProviderPreset;

    const result = sendUiPrompt(
      session,
      provider,
      { manualInterventionTimeoutMs: 1000 } as AppConfig,
      'olá'
    );

    if (mode === 'click-error') {
      await assert.rejects(result, /click failed/);
      assert.equal(clicks, 1);
      return;
    }

    await result;
    assert.equal(composerText, '');
    assert.equal(clicks, mode === 'enter' ? 0 : 1);
    assert.equal(enters, mode === 'enter' ? 1 : 0);
  });
}
