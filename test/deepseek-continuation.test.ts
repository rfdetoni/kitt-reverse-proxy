import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { DEEPSEEK_PLUGIN } from '../src/plugins/default/deepseek.js';
import { resumeDeepseekGeneration, isSafeGenerationContinuationLabel } from '../src/runtime/ui-continuation.js';

const provider = DEEPSEEK_PLUGIN.provider;

function pageFixture(opts: { label?: string; output?: string; current?: string;
    approved?: boolean; enabled?: boolean; url?: string; multiple?: boolean } = {}) {
  const calls: string[] = [];
  const label = opts.label ?? 'Continue';
  const output = opts.output ?? '{"action":"final_response",';
  const response = {
    innerText: output, textContent: output,
    parentElement: null as any
  };
  const button = {
    textContent: label,
    getAttribute: (key: string) => key === 'aria-label' ? label : null,
    getBoundingClientRect: () => ({width: 80, height: 32}),
    closest: (_selector: string) => null
  };
  const card = {
    parentElement: null as any,
    matches: (_selector: string) => false,
    querySelectorAll: (selector: string) => selector === 'button'
      ? (opts.multiple ? [button, button] : [button]) : []
  };
  response.parentElement = card;
  const documentFixture = {
    body: {}, documentElement: {},
    querySelectorAll: (selector: string) => selector === '.ds-assistant-message-main-content'
      ? [response] : selector === 'button' ? [button] : []
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
      assert.equal(selector, 'button');
      return {nth: (index: number) => {
        assert.equal(index, 0);
        return {
          isVisible: async () => true,
          isEnabled: async () => opts.enabled ?? true,
          getAttribute: async () => label,
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
