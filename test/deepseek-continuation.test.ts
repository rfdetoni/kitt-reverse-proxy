import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { DEEPSEEK_PLUGIN } from '../src/plugins/default/deepseek.js';
import { resumeDeepseekGeneration, isSafeGenerationContinuationLabel } from '../src/runtime/ui-continuation.js';

const provider = DEEPSEEK_PLUGIN.provider;

function pageFixture(opts: { label?: string; output?: string; current?: string;
    enabled?: boolean; url?: string; multiple?: boolean; footerLevels?: number;
    roleButton?: boolean; ariaLabel?: string; stoppedError?: boolean; noButton?: boolean } = {}) {
  const calls: string[] = [];
  const label = opts.label ?? 'Continue';
  const output = opts.output ?? '{"action":"final_response",';
  const response = {
    innerText: output, textContent: output,
    parentElement: null as any
  };
  const button = {
    textContent: label,
    getAttribute: (key: string) => key === 'aria-label' ? (opts.ariaLabel ?? label) : null,
    hasAttribute: (_key: string) => false,
    getBoundingClientRect: () => ({width: 80, height: 32}),
    closest: (_selector: string) => null
  };
  const statusText = opts.stoppedError ? 'Servidor está temporariamente indisponível.\nParado' : '';
  const card = {
    innerText: output + '\n' + statusText,
    textContent: output + '\n' + statusText,
    parentElement: null as any,
    matches: (_selector: string) => false,
    querySelectorAll: (selector: string) => selector === 'button, [role="button"]'
      ? (opts.noButton ? [] : opts.multiple ? [button, button] : [button])
      : selector === '.ds-assistant-message-main-content' ? [response] : []
  };
  response.parentElement = card;
  if (opts.footerLevels) {
    let next = card;
    for (let level = 0; level < opts.footerLevels; level++) {
      const previous = next;
      next = {
        innerText: output + '\n' + statusText,
        textContent: output + '\n' + statusText,
        parentElement: previous,
        matches: (_selector: string) => false,
        querySelectorAll: (selector: string) =>
          selector === '.ds-assistant-message-main-content' ? [response] : []
      };
    }
    response.parentElement = next;
  }
  const documentFixture = {
    body: {}, documentElement: {},
    querySelectorAll: (selector: string) => selector === '.ds-assistant-message-main-content'
      ? [response] : selector === 'button, [role="button"]' ? (opts.noButton ? [] : [button]) : []
  };
  const page = {
    url: () => opts.url ?? 'https://chat.deepseek.com/',
    evaluate: async (fn: (args: unknown) => unknown, arg: unknown) => {
      const host = globalThis as typeof globalThis & { document?: any; window?: any };
      const d = host.document, w = host.window;
      host.document = documentFixture;
      host.window = {getComputedStyle: () => ({visibility:'visible',display:'block'})};
      try { return fn(arg); } finally {
        if (d === undefined) delete host.document; else host.document = d;
        if (w === undefined) delete host.window; else host.window = w;
      }
    },
    locator: (selector: string) => {
      assert.equal(selector, 'button, [role="button"]');
      return {nth: (index: number) => {
        assert.equal(index, 0);
        return {
          isVisible: async () => true,
          isEnabled: async () => opts.enabled ?? true,
          getAttribute: async () => (opts.ariaLabel ?? label),
          textContent: async () => label,
          click: async () => { calls.push('click'); }
        };
      }};
    }
  } as unknown as Page;
  return {page, calls, output};
}

test('only exact generation continuation labels are allowed', () => {
  for (const label of ['Continue', 'Continue generating', 'Continuar', 'Continuar gerando']) {
    assert.equal(isSafeGenerationContinuationLabel(label), true, label);
  }
  for (const label of ['Continue with Google', 'Continue to payment', 'Authorize', 'Allow all',
    'Confirm', 'Continuar com Google', 'I agree', 'Continue chat elsewhere', '']) {
    assert.equal(isSafeGenerationContinuationLabel(label), false, label);
  }
});

test('only a fresh current DeepSeek assistant card can resume, once', async () => {
  const {page, calls, output} = pageFixture();
  assert.equal(await resumeDeepseekGeneration(page, provider, output), 'resumed');
  assert.deepEqual(calls, ['click']);
  assert.equal(await resumeDeepseekGeneration(page, provider, output, undefined, false), 'paused');
  assert.deepEqual(calls, ['click'], 'second detection is read-only');
});

test('do not click stale assistant content, unrelated prompts or unsafe origins', async () => {
  for (const opts of [
    {current: 'new text', label: 'Continue'},
    {label: 'Continue with Google'},
    {multiple: true},
    {url: 'https://auth.deepseek.com/'}
  ]) {
    const {page, calls, output} = pageFixture(opts);
    const current = opts.current ?? output;
    assert.equal(await resumeDeepseekGeneration(page, provider, current), 'absent');
    assert.deepEqual(calls, []);
  }
});

test('screenshot layout: stopped DeepSeek response with footer Continue seven wrappers away', async () => {
  const {page, output, calls} = pageFixture({label: 'Continuar', footerLevels: 7});
  assert.equal(await resumeDeepseekGeneration(page, provider, output), 'resumed');
  assert.deepEqual(calls, ['click']);
});

test('a server-unavailable stopped answer cannot be returned as final if its Continue footer is missing', async () => {
  const {page, output, calls} = pageFixture({
    label: 'Continuar', footerLevels: 7, stoppedError: true, noButton: true
  });
  assert.equal(await resumeDeepseekGeneration(page, provider, output), 'manual');
  assert.deepEqual(calls, []);
});

test('footer candidate cannot disguise an unsafe aria label', async () => {
  const {page, output, calls} = pageFixture({label: 'Continuar', ariaLabel: 'Continue with Google', footerLevels: 7});
  assert.equal(await resumeDeepseekGeneration(page, provider, output), 'absent');
  assert.deepEqual(calls, []);
});

test('disabled generation continuation requires manual intervention, never retries', async () => {
  const {page, output, calls} = pageFixture({enabled: false});
  assert.equal(await resumeDeepseekGeneration(page, provider, output), 'manual');
  assert.deepEqual(calls, []);
});

test('do not use DeepSeek continuation helper for another provider', async () => {
  const {page, output, calls} = pageFixture();
  assert.equal(await resumeDeepseekGeneration(page, {...provider,id:'chatgpt'}, output), 'absent');
  assert.deepEqual(calls, []);
});
