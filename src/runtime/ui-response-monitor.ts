import { RESOURCE_LIMITS } from '../core/resource-limits.js';
import type { ProviderPreset } from '../providers/catalog.js';
import type { AppConfig, ChatExecutionOptions, LiveBrowserSession } from '../types.js';
import {
  anyVisible,
  collectVisibleSnapshots,
  inspectCompletedAssistantContract,
  readVisibleSnapshotSlot,
  selectChangedSnapshot,
  selectCompletedAssistantContract,
  type UiTextSnapshot
} from './ui-dom.js';
import { abortableSleep, throwIfAborted } from './cancellation.js';
import { browserGate, waitForUiReady } from './ui-interaction.js';
import { ManualInterventionRequiredError, UiTimeoutError } from './ui-errors.js';
import { deltaFromCumulative } from './ui-history.js';
import { selectorCandidates } from './semantic-locator.js';
import { logger } from '../logger.js';
import { sameContractText } from './read/contract-text.js';
import { transportPayload } from './read/contract-text.js';

/** Progress from a matched CDP response, not arbitrary page mutations. */
/** Strict model-frame validation is necessary but DOM provenance is still required. */
export function verifiedLogicalCompletion(assistantText: string, correlatedFrame: string): boolean {
  if (!assistantText || !correlatedFrame) return false;
  try {
    transportPayload(correlatedFrame, true);
    transportPayload(assistantText, true);
    return sameContractText(assistantText, correlatedFrame);
  } catch { return false; }
}

export interface UiTransportActivity {
  lastByteAt?: number;
  receiving: boolean;
  /** Strictly parsed current-turn JSON object from a pretrusted, correlated CDP tap. */
  completedContract?: string;
}

export interface UiResponseResult {
  text: string;
  deltas: string[];
  firstDeltaMs: number | undefined;
  durationMs: number;
}

export function uiResponseWatchdogBudget(timeoutMs: number): {
  inactivityMs: number;
  absoluteMs: number;
} {
  const inactivityMs = Math.max(1_000, Math.floor(timeoutMs));
  const extended = Math.max(inactivityMs * 2, inactivityMs + 120_000);
  const absoluteMs = Math.max(inactivityMs, Math.min(900_000, extended));
  return { inactivityMs, absoluteMs };
}


export function uiResponseAbsoluteBudget(timeoutMs: number, generating: boolean): number {
  const normal = uiResponseWatchdogBudget(timeoutMs).absoluteMs;
  return generating ? Math.max(normal, 900_000) : normal;
}

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
    type DomWatcher = {
      root: Element;
      observer: MutationObserver;
      listeners: Set<() => void>;
      idleTimer: number | undefined;
    };
    const doc = document as Document & { __kittDomWatcher?: DomWatcher };
    let watcher = doc.__kittDomWatcher;
    if (!watcher || watcher.root !== root) {
      watcher?.observer.disconnect();
      const listeners = new Set<() => void>();
      const observer = new MutationObserver(() => {
        for (const wake of listeners) wake();
      });
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-busy', 'data-state', 'class']
      });
      watcher = { root, observer, listeners, idleTimer: undefined };
      doc.__kittDomWatcher = watcher;
    }
    if (watcher.idleTimer !== undefined) {
      window.clearTimeout(watcher.idleTimer);
      watcher.idleTimer = undefined;
    }
    const current = watcher;
    let settled = false;
    let timer = 0;
    const wake = (): void => finish(true);
    const finish = (changed: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      current.listeners.delete(wake);
      if (current.listeners.size === 0) {
        current.idleTimer = window.setTimeout(() => {
          if (doc.__kittDomWatcher === current && current.listeners.size === 0) {
            current.observer.disconnect();
            delete doc.__kittDomWatcher;
          }
        }, 2_000);
      }
      resolve(changed);
    };
    current.listeners.add(wake);
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
  signal?: AbortSignal,
  tapActivity?: () => UiTransportActivity | undefined,
  preferRawContract = false
): Promise<UiResponseResult> {
  const startedAt = Date.now();
  const watchdog = uiResponseWatchdogBudget(config.uiResponseTimeoutMs);
  const absoluteDeadline = startedAt + watchdog.absoluteMs;
  // A verified, actively generating web chat may take much longer than the
  // regular idle budget on large requests. Still cap the entire UI turn.
  const generatingDeadline = startedAt + uiResponseAbsoluteBudget(config.uiResponseTimeoutMs, true);
  const streamingSelectors = selectorCandidates(provider.ui.streamingSelectors, 'streaming').map((item) => item.selector);
  let lastActivityAt = startedAt;
  const deltas: string[] = [];
  let firstDeltaMs: number | undefined;
  let retainedDeltaChars = 0;
  let lastText = '';
  let streamedText = '';
  let stableSince = 0;
  let observedStreaming = false;
  let observedTap = false;
  let streaming = false;
  let activeSnapshot: UiTextSnapshot | undefined;
  let nextGateCheckAt = startedAt;
  let nextStreamingCheckAt = startedAt;
  let nextProgressLogAt = startedAt + 30_000;
  let generationStoppedAt = 0;
  let nextAssistantProbeAt = 0;
  let assistantProbeLogged = false;
  let completedAssistantCandidate = '';
  let completedAssistantSince = 0;
  let malformedReplyCandidate = '';
  let malformedReplySince = 0;
  let nextContractScanAt = startedAt;
  let lastDomProbe: { textSamples: number; visibleEndMarkers: number; freshVisibleChars?: number;
    compactCandidates?: number; freshCompactCandidates?: number; maxSampleChars?: number; mutationSamples?: number } | undefined;

  await abortableSleep(250, signal);

  while (Date.now() < (observedStreaming || observedTap || firstDeltaMs !== undefined ? generatingDeadline : absoluteDeadline)) {
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
      streaming = await anyVisible(session.page, streamingSelectors);
      observedStreaming ||= streaming;
      if (streaming) lastActivityAt = now;
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
      lastActivityAt = stableSince;
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

    // Independent DOM observer. A complete fresh JSON frame is stronger
    // completion evidence than spinner/Stop-button state, which may be stale.
    // Probe the current assistant-owned turn even when the CDP tap is absent
    // or still receiving, and require a stable observation before returning.
    if (preferRawContract && (provider.id === 'chatgpt' || provider.id === 'gemini')
        && Date.now() >= nextContractScanAt) {
      nextContractScanAt = Date.now() + 500;
      const direct = selectCompletedAssistantContract(lastText ? [lastText] : [], baseline, sentPrompt);
      const probe = direct ? undefined : await inspectCompletedAssistantContract(session.page, baseline, sentPrompt);
      if (probe) lastDomProbe = probe;
      const found = direct ?? probe?.text ?? '';
      if (found !== completedAssistantCandidate) {
        completedAssistantCandidate = found;
        completedAssistantSince = Date.now();
      }
      if (found && Date.now() - completedAssistantSince >= Math.max(750, config.uiSettleMs)) {
        logger.debug('ui.response.dom_contract_complete', { provider_id: provider.id,
          response_chars: found.length, streaming });
        return { text: found, deltas: [], firstDeltaMs: firstDeltaMs ?? Date.now() - startedAt,
          durationMs: Date.now() - startedAt };
      }
      // If WebChat rendered the model reply but changed whitespace or broke
      // JSON syntax, return only a proven FRESH, stable, delimited reply to
      // the existing host-owned contract repair path. This is never a parsed
      // or authorized tool action, and never an upstream replay.
      const malformed = probe?.repairText ?? '';
      if (malformed !== malformedReplyCandidate) {
        malformedReplyCandidate = malformed;
        malformedReplySince = Date.now();
      }
      if (malformed && !streaming
          && Date.now() - malformedReplySince >= Math.max(3_500, config.uiSettleMs)) {
        logger.event('warn', 'ui.response.dom_unparsed_for_repair', {
          provider_id: provider.id, response_chars: malformed.length,
          stopped_generating: observedStreaming && !streaming
        });
        return { text: malformed, deltas: [],
          firstDeltaMs: firstDeltaMs ?? Date.now() - startedAt,
          durationMs: Date.now() - startedAt };
      }
    }

    const tap = tapActivity?.();
    // Correlated response bytes are progress even when the UI is still
    // rendering or its assistant selectors do not match current markup.
    if (tap?.lastByteAt && tap.lastByteAt > lastActivityAt && tap.lastByteAt <= Date.now()) {
      lastActivityAt = tap.lastByteAt;
      observedTap = true;
    }

    if (streaming) generationStoppedAt = 0;

    // A correlated HTTP response may remain open after the browser stops
    // generating. A delimiter alone is not proof: require a complete
    // schema-valid JSON object, prior CDP trust and the current assistant-owned
    // DOM turn to agree semantically before ending the *logical* wait.
    // This does not abort the web provider or replay the request.
    if (provider.id === 'chatgpt' && observedStreaming && !streaming
        && tap?.receiving && tap.completedContract) {
      if (!generationStoppedAt) generationStoppedAt = Date.now();
      const settleMs = Math.max(750, config.uiSettleMs);
      // Do not mistake a transient closing brace during an actively arriving stream
      // for stable completion. Require both UI and CDP-byte quiet periods.
      if (tap.lastByteAt && Date.now() - tap.lastByteAt >= settleMs
          && Date.now() - generationStoppedAt >= settleMs) {
        const probe = await inspectCompletedAssistantContract(session.page, baseline, sentPrompt);
        if (probe.text && verifiedLogicalCompletion(probe.text, tap.completedContract)) {
          logger.debug('ui.response.verified_logical_completion', {
            provider_id: provider.id, response_chars: probe.text.length,
            stopped_for_ms: Date.now() - generationStoppedAt
          });
          return { text: probe.text, deltas: [], firstDeltaMs: firstDeltaMs ?? Date.now() - startedAt,
            durationMs: Date.now() - startedAt };
        }
      }
    }
    if (provider.id === 'chatgpt' && observedStreaming && !streaming
        && !tap?.receiving && !lastText) {
      if (!generationStoppedAt) generationStoppedAt = Date.now();
      if (Date.now() >= nextAssistantProbeAt) {
        const probe = await inspectCompletedAssistantContract(session.page, baseline, sentPrompt);
        nextAssistantProbeAt = Date.now() + 2_000;
        if (probe.text) {
          logger.debug('ui.response.assistant_fallback', {
            provider_id: provider.id, response_chars: probe.text.length,
            stopped_for_ms: Date.now() - generationStoppedAt
          });
          return { text: probe.text, deltas: [], firstDeltaMs: Date.now() - startedAt,
            durationMs: Date.now() - startedAt };
        }
        if (!assistantProbeLogged && Date.now() - generationStoppedAt >= 5_000) {
          assistantProbeLogged = true;
          logger.event('warn', 'ui.response.capture_missing', {
            provider_id: provider.id, assistant_nodes: probe.assistantNodes, structural_turn_nodes: probe.structuralTurnNodes,
            text_samples: probe.textSamples, visible_end_markers: probe.visibleEndMarkers,
            fresh_visible_chars: probe.freshVisibleChars ?? 0,
            unparsed_fresh_candidate: Boolean(probe.repairText),
            compact_candidates: probe.compactCandidates ?? 0,
            fresh_compact_candidates: probe.freshCompactCandidates ?? 0,
            max_sample_chars: probe.maxSampleChars ?? 0,
            fresh_dom_mutation_samples: probe.mutationSamples ?? 0
          });
        }
      }
      if (Date.now() - generationStoppedAt >= 20_000) {
        throw new UiTimeoutError(
          'O ChatGPT terminou de gerar, mas o proxy não conseguiu extrair a resposta do assistente.'
        );
      }
    }

    if (!streaming && !tap?.receiving && lastText && !isThinkingIndicator(lastText)) {
      if (stableSince === 0) stableSince = Date.now();
      const contractCapture = preferRawContract && ['chatgpt', 'gemini'].includes(provider.id);
      const hasCompleteContract = contractCapture
        ? Boolean(selectCompletedAssistantContract([lastText], baseline, sentPrompt))
        : false;
      // Completed JSON objects take the fast, strictly parsed path above.
      // But INVALID stable answers must still reach the Agent contract repair
      // loop. Waiting for a strictly valid frame here would turn every
      // repairable syntax failure into a transport timeout.
      const settleMs = contractCapture && !hasCompleteContract
        ? Math.max(3_500, config.uiSettleMs)
        : observedStreaming
          ? Math.max(750, config.uiSettleMs)
          : Math.max(1_250, config.uiSettleMs);
      if (Date.now() - stableSince >= settleMs) {
        return { text: lastText, deltas, firstDeltaMs, durationMs: Math.max(0, Date.now() - startedAt) };
      }
    }

    if (Date.now() >= nextProgressLogAt) {
      logger.debug('ui.response.progress', {
        provider_id: provider.id, elapsed_ms: Date.now() - startedAt,
        idle_ms: Date.now() - lastActivityAt, response_chars: lastText.length,
        observed_streaming: observedStreaming, streaming, observed_tap: observedTap,
        tap_receiving: tap?.receiving ?? false,
        tap_last_byte_ago_ms: tap?.lastByteAt ? Date.now() - tap.lastByteAt : null,
        dom_samples: lastDomProbe?.textSamples ?? 0,
        dom_end_markers: lastDomProbe?.visibleEndMarkers ?? 0,
        dom_fresh_visible_chars: lastDomProbe?.freshVisibleChars ?? 0,
        dom_compact_candidates: lastDomProbe?.compactCandidates ?? 0,
        dom_fresh_compact_candidates: lastDomProbe?.freshCompactCandidates ?? 0,
        dom_mutation_samples: lastDomProbe?.mutationSamples ?? 0
      });
      nextProgressLogAt = Date.now() + 30_000;
    }

    if (Date.now() - lastActivityAt >= watchdog.inactivityMs) {
      logger.event('warn', 'ui.response.timeout', {
        provider_id: provider.id, wait_ms: Date.now() - startedAt, response_chars: lastText.length,
        first_delta_ms: firstDeltaMs ?? null, observed_streaming: observedStreaming,
        streaming, idle_ms: Date.now() - lastActivityAt
      });
      throw new UiTimeoutError(
        `Nenhum progresso do chat foi detectado em ${Math.round(watchdog.inactivityMs / 1000)}s.`
      );
    }

    await abortableSleep(streaming ? 120 : 200, signal);
    // Arbitrary page mutations (animations/sidebar) are not model progress.
    // They only wake the polling loop; actual text or the generating control
    // determines progress, bounded by the absolute generating deadline.
    await waitForDomMutation(session, streaming ? 260 : 450, signal);
  }

  throw new UiTimeoutError(
    `O chat excedeu o teto absoluto de ${Math.round(((observedStreaming || observedTap || firstDeltaMs !== undefined ? generatingDeadline : absoluteDeadline) - startedAt) / 1000)}s sem resposta final.`
  );
}
