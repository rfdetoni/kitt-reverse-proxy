import { RESOURCE_LIMITS } from '../core/resource-limits.js';
import type { ProviderPreset } from '../providers/catalog.js';
import type { AppConfig, ChatExecutionOptions, LiveBrowserSession } from '../types.js';
import {
  anyVisible,
  collectVisibleSnapshots,
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
  const deadline = Date.now() + config.uiResponseTimeoutMs;
  const deltas: string[] = [];
  let retainedDeltaChars = 0;
  let lastText = '';
  let streamedText = '';
  let stableSince = 0;
  let observedStreaming = false;

  await abortableSleep(250, signal);

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const gate = await browserGate(session.page, provider);
    if (gate) {
      if (!config.headed) throw new ManualInterventionRequiredError(`${gate.message} Requer intervenção manual.`);
      await waitForUiReady(session, provider, config, 'desafio de segurança', signal);
    }

    const streaming = await anyVisible(session.page, provider.ui.streamingSelectors);
    observedStreaming ||= streaming;
    const current = await collectVisibleSnapshots(session.page, provider.ui.responseSelectors);
    const active = selectChangedSnapshot(baseline, current, sentPrompt);

    if (active?.text && active.text !== lastText) {
      lastText = active.text;
      stableSince = Date.now();
      if (!isThinkingIndicator(active.text)) {
        const delta = deltaFromCumulative(streamedText, active.text);
        if (delta) {
          streamedText = active.text.trim();
          if (onDelta) {
            await onDelta(delta);
          } else if (retainedDeltaChars + delta.length <= RESOURCE_LIMITS.uiDeltaChars) {
            deltas.push(delta);
            retainedDeltaChars += delta.length;
          }
        }
      }
    }

    if (!streaming && lastText && !isThinkingIndicator(lastText)) {
      if (stableSince === 0) stableSince = Date.now();
      const settleMs = observedStreaming
        ? Math.max(750, config.uiSettleMs)
        : Math.max(1_250, config.uiSettleMs);
      if (Date.now() - stableSince >= settleMs) return { text: lastText, deltas };
    }

    await abortableSleep(streaming ? 140 : 280, signal);
  }

  if (lastText && !isThinkingIndicator(lastText)) return { text: lastText, deltas };
  throw new UiTimeoutError(`Nenhuma resposta do chat foi detectada em ${Math.round(config.uiResponseTimeoutMs / 1000)}s.`);
}
