import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { DEEPSEEK_PLUGIN } from '../src/plugins/default/deepseek.js';
import { collectVisibleSnapshots, readVisibleSnapshotSlot, selectChangedSnapshot } from '../src/runtime/ui-dom.js';

interface FakeElement {
  innerText: string;
  textContent: string;
  id: string;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
  closest(selector: string): object | null;
}

function fakeElement(text: string, role: 'thinking' | 'answer'): FakeElement {
  return {
    innerText: text, textContent: text, id: role,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 360, height: 250 }),
    closest: (selector: string) => {
      const excluded = DEEPSEEK_PLUGIN.provider.ui.responseExcludeSelectors ?? [];
      return role === 'thinking' && excluded.includes(selector) && selector.includes('thinking')
        ? {} : null;
    }
  };
}

function syntheticPage(thought: FakeElement, final: FakeElement): Page {
  // Evaluate the same browser-side callback against a minimal DOM fixture.
  const frame = {
    isDetached: () => false,
    evaluate: async (fn: (arg: any) => any, arg: unknown) => {
      const globalState = globalThis as typeof globalThis & {document?: any; window?: any};
      const priorDoc = globalState.document;
      const priorWindow = globalState.window;
      globalState.document = {
        querySelectorAll: (selector: string) => selector.includes('ds-assistant-message-main-content')
          ? (final === thought ? [] : [final])
          : selector === '.ds-markdown' ? [thought, final] : []
      };
      globalState.window = {
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
      };
      try { return fn(arg); } finally {
        if (priorDoc === undefined) delete globalState.document;
        else globalState.document = priorDoc;
        if (priorWindow === undefined) delete globalState.window;
        else globalState.window = priorWindow;
      }
    }
  };
  return {frames: () => [frame]} as unknown as Page;
}

test('DeepSeek plugin uses narrow answer leaves and explicitly excludes thinking panels', () => {
  const provider = DEEPSEEK_PLUGIN.provider;
  assert.equal(DEEPSEEK_PLUGIN.version, '1.1.0');
  assert.equal(provider.ui.selectorVersion, 2);
  assert.equal(provider.ui.responseSelectors.some(s => s === '[data-role="assistant"]'), false);
  assert.equal(provider.ui.responseSelectors.some(s => s === '.ds-markdown'), false);
  assert.ok(provider.ui.responseSelectors.every(s => s.includes('ds-assistant-message-main-content')));
  assert.equal(provider.ui.responseSelectors.some(s => s === '[data-testid*="assistant" i]'), false);
  assert.ok(provider.ui.responseExcludeSelectors?.some(s => s.includes('thinking')));
});

test('DeepSeek reasoning is never selected, including when an active snapshot is re-read', async () => {
  const ui = DEEPSEEK_PLUGIN.provider.ui;
  const thought = fakeElement('Need emit valid JSON ... internal analysis', 'thinking');
  const answer = fakeElement('{"action":"final_response","content":"OK"}', 'answer');
  const page = syntheticPage(thought, answer);
  const snapshots = await collectVisibleSnapshots(page, ui.responseSelectors, ui.responseExcludeSelectors);
  assert.ok(snapshots.length > 0);
  assert.ok(snapshots.every(snapshot => !snapshot.text.includes('internal analysis')));
  const selected = selectChangedSnapshot([], snapshots, 'unrelated submitted prompt');
  assert.ok(selected);
  assert.match(selected.text, /final_response/);
  const reRead = await readVisibleSnapshotSlot(page, selected, ui.responseExcludeSelectors);
  assert.equal(reRead?.text, selected.text);
  // Simulate a stale snapshot from the old generic Markdown selector;
  // even if retained across a provider refresh it cannot expose thoughts.
  const oldReasoning = {
    ...selected, selector: '.ds-markdown', count: 2,
    index: 0, identity: 'thought', text: thought.innerText
  };
  assert.equal(await readVisibleSnapshotSlot(page, oldReasoning, ui.responseExcludeSelectors), undefined);
});

test('DeepSeek thinking-only DOM yields no answer candidate (fail closed)', async () => {
  const ui = DEEPSEEK_PLUGIN.provider.ui;
  const thought = fakeElement('Need emit valid JSON ... internal analysis', 'thinking');
  const page = syntheticPage(thought, thought);
  const snapshots = await collectVisibleSnapshots(page, ui.responseSelectors, ui.responseExcludeSelectors);
  assert.deepEqual(snapshots, []);
});
