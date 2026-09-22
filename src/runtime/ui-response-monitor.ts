import { RESOURCE_LIMITS } from '../core/resource-limits.js';
import type { ProviderPreset } from '../providers/catalog.js';
import type { AppConfig, ChatExecutionOptions, LiveBrowserSession } from '../types.js';
import {
  anyVisible,
  collectVisibleSnapshots,
  readVisibleSnapshotSlot,
  selectChangedSnapshot,
  type UiTextSnapshot
} from './ui-dom.js';
import { abortableSleep, throwIfAborted } from './cancellation.js';
import { browserGate, waitForUiReady } from './ui-interaction.js';
import { ManualInterventionRequiredError, UiTimeoutError } from './ui-errors.js';
import { deltaFromCumulative } from './ui-history.js';

export interface UiResponseResult {
  text: string;
  deltas: string[];
  firstDeltaMs: number | undefined;
  durationMs: number;
}

const FIRST_USEFUL_DELTA_TIMEOUT_MS = 90_000;

async function waitForDomMutation(
  session: LiveBrowserSession,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  throwIfAborted(signal);
  const bounded = Math.max(50, Math.min(1_000, timeoutMs));
  const mutation = session.page.evaluate((waitMs) => new Promise<boolean>((resolve) => {
    const root = document.body || document.documentElement;
    if (!root || typeof MutationObserver === 'undefined') {
      window.setTimeout(() => resolve(false), waitMs);
      return;
    }
    let settled = false;
    let timer = 0;
    const finish = (changed: boolean): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(changed);
    };
    const observer = new MutationObserver(() => finish(true));
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['aria-busy', 'data-state', 'class']
    });
    timer = window.setTimeout(() => finish(false), waitMs);
  }), bounded).catch(() => false);
  if (!signal) return mutation;
  return Promise.race([
    mutation,
    abortableSleep(bounded, signal).then(() => false)
  ]);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function providerSpeakerLabels(provider: Pick<ProviderPreset, 'id' | 'name'>): string[] {
  if (provider.id === 'generic') return [];
  const displayName = provider.name.replace(/\s+web$/i, '').trim();
  return [...new Set([provider.id, displayName].map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
}

/** Remove browser-UI speaker chrome without altering the model's actual answer. */
export function cleanUiResponseText(
  text: string,
  provider: Pick<ProviderPreset, 'id' | 'name'>
): string {
  let cleaned = text.trim();
  for (const label of providerSpeakerLabels(provider)) {
    const prefix = new RegExp(
      `^(?:(?:o|a)\\s+)?${escapeRegex(label)}\\s+(?:disse|diz|respondeu|said|says|replied)\\s*:?\\s*`,
      'i'
    );
    const next = cleaned.replace(prefix, '').trim();
    if (next !== cleaned) return next;
  }
  return cleaned;
}

function isThinkingIndicator(text: string): boolean {
  const value = text.trim().toLowerCase();
  return (
    value === 'pensando'
    || value === 'pensando...'
    || value === 'thinking'
    || value === 'thinking...'
    || /^pensou (durante|por|há) \d+/i.test(value)
    || /^thought for \d+/i.test(value)
    || /^pensando (há|por) \d+/i.test(value)
  );
}

export async function awaitUiResponse(
  session: LiveBrowserSession,
  provider: ProviderPreset,
  config: AppConfig,
  baseline: readonly UiTextSnapshot[],
  sentPrompt: string,
  onDelta?: ChatExecutionOptions['onDelta'],
  signal?: AbortSignal
): Promise<UiResponseResult> {
  const startedAt = Date.now();
  const deadline = startedAt + config.uiResponseTimeoutMs;
  const firstUsefulDeltaDeadline = Math.min(deadline, startedAt + FIRST_USEFUL_DELTA_TIMEOUT_MS);
  const deltas: string[] = [];
  let firstDeltaMs: number | undefined;
  let retainedDeltaChars = 0;
  let lastText = '';
  let streamedText = '';
  let stableSince = 0;
  let observedStreaming = false;
  let streaming = false;
  let activeSnapshot: UiTextSnapshot | undefined;
  let nextGateCheckAt = startedAt;
  let nextStreamingCheckAt = startedAt;

  await abortableSleep(250, signal);

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const now = Date.now();
    if (now >= nextGateCheckAt) {
      const gate = await browserGate(session.page, provider);
      nextGateCheckAt = now + (firstDeltaMs === undefined ? 750 : 2_000);
      if (gate) {
        if (!config.headed) throw new ManualInterventionRequiredError(`${gate.message} Requer intervenção manual.`);
        await waitForUiReady(session, provider, config, 'desafio de segurança', signal);
      }
    }

    if (now >= nextStreamingCheckAt) {
      streaming = await anyVisible(session.page, provider.ui.streamingSelectors);
      observedStreaming ||= streaming;
      nextStreamingCheckAt = now + (streaming ? 350 : 600);
    }

    let active: UiTextSnapshot | undefined;
    if (activeSnapshot) {
      active = await readVisibleSnapshotSlot(session.page, activeSnapshot);
      if (!active) activeSnapshot = undefined;
    }
    if (!active) {
      const current = await collectVisibleSnapshots(session.page, provider.ui.responseSelectors);
      active = selectChangedSnapshot(baseline, current, sentPrompt);
      if (active) activeSnapshot = active;
    }
    const activeText = active?.text ? cleanUiResponseText(active.text, provider) : '';

    if (activeText && activeText !== lastText) {
      lastText = activeText;
      stableSince = Date.now();
      if (!isThinkingIndicator(activeText)) {
        const delta = deltaFromCumulative(streamedText, activeText);
        if (delta) {
          if (firstDeltaMs === undefined) firstDeltaMs = Math.max(0, Date.now() - startedAt);
          streamedText = activeText.trim();
          if (onDelta) {
            await onDelta(delta);
          } else if (retainedDeltaChars + delta.length <= RESOURCE_LIMITS.uiDeltaChars) {
            deltas.push(delta);
            retainedDeltaChars += delta.length;
          }
        }
      }
    }

    if (firstDeltaMs === undefined && Date.now() >= firstUsefulDeltaDeadline) {
      throw new UiTimeoutError(
        `Nenhum delta útil do chat foi detectado em ${Math.round((firstUsefulDeltaDeadline - startedAt) / 1000)}s.`
      );
    }

    if (!streaming && lastText && !isThinkingIndicator(lastText)) {
      if (stableSince === 0) stableSince = Date.now();
      const settleMs = observedStreaming
        ? Math.max(750, config.uiSettleMs)
        : Math.max(1_250, config.uiSettleMs);
      if (Date.now() - stableSince >= settleMs) return { text: lastText, deltas, firstDeltaMs, durationMs: Math.max(0, Date.now() - startedAt) };
    }

    await abortableSleep(streaming ? 120 : 200, signal);
    await waitForDomMutation(session, streaming ? 260 : 450, signal);
  }

  if (lastText && !isThinkingIndicator(lastText)) return { text: lastText, deltas, firstDeltaMs, durationMs: Math.max(0, Date.now() - startedAt) };
  throw new UiTimeoutError(`Nenhuma resposta do chat foi detectada em ${Math.round(config.uiResponseTimeoutMs / 1000)}s.`);
}
