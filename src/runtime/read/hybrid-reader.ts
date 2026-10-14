import { completedRawContract, selectContractResponseText } from './contract-text.js';
import { UiTimeoutError } from '../ui-errors.js';
export { selectContractResponseText } from './contract-text.js';
import type { AppConfig, ChatExecutionOptions, JsonObject, LiveBrowserSession } from '../../types.js';
import type { ProviderPreset } from '../../providers/catalog.js';
import {
  awaitUiResponse,
  type UiResponseResult
} from '../ui-response-monitor.js';
import type { UiTextSnapshot } from '../ui-dom.js';
import { logger } from '../../logger.js';
import { CdpStreamTap } from './tap-cdp.js';
import { TapStreamAdapter } from './tap-adapter.js';
import { ResponseReconciler } from './reconciler.js';
import type {
  ReadDiagnostics,
  TapFailureReason,
  TapTurn
} from './types.js';

export interface HybridUiResponseResult extends UiResponseResult {
  snapshots?: string[];
  readDiagnostics: ReadDiagnostics;
}

export class HybridUiResponseReader {
  private readonly tap: CdpStreamTap;
  private pending: TapTurn | undefined;

  /** On ChatGPT Web the DOM is authoritative: CDP network streams can carry
   * megabytes of unrelated events and never report a usable KAP frame. */
  private domOnly(): boolean {
    return this.config.readMode === 'dom'
      || (this.provider.id === 'chatgpt' && this.config.readMode !== 'tap');
  }

  constructor(
    private readonly session: LiveBrowserSession,
    private readonly provider: ProviderPreset,
    private readonly config: AppConfig,
    private readonly monitor: typeof awaitUiResponse = awaitUiResponse
  ) {
    this.tap = new CdpStreamTap(session, provider, config);
  }

  async initialize(): Promise<void> {
    if (!this.domOnly()) await this.tap.initialize();
  }

  arm(prompt: string): void {
    this.pending?.cancel();
    if (!this.domOnly()) this.pending = this.tap.arm(prompt);
  }

  cancelPending(): void {
    this.pending?.cancel();
    this.pending = undefined;
  }

  async reset(): Promise<void> {
    this.cancelPending();
    if (!this.domOnly()) await this.tap.reconnect();
  }

  describe(): JsonObject {
    return {
      mode: this.domOnly() ? 'dom' : (this.config.readMode ?? 'auto'),
      final_source: 'dom',
      dom_warm_standby: true,
      tap: this.tap.health()
    };
  }

  async read(
    baseline: readonly UiTextSnapshot[],
    sentPrompt: string,
    onDelta?: ChatExecutionOptions['onDelta'],
    signal?: AbortSignal,
    preferRawContract = false
  ): Promise<HybridUiResponseResult> {
    const turn = this.pending;
    this.pending = undefined;

    if (this.domOnly() || !turn || turn.mode === 'disabled') {
      turn?.cancel();
      const dom = await this.monitor(
        this.session,
        this.provider,
        this.config,
        baseline,
        sentPrompt,
        onDelta,
        signal,
        undefined,
        preferRawContract
      );
      return {
        ...dom,
        readDiagnostics: {
          mode: this.domOnly() ? 'dom' : (this.config.readMode ?? 'auto'),
          source: 'dom',
          tap_mode: 'disabled',
          tap_verified: false,
          tap_trusted: Boolean(this.tap.health().trusted)
        }
      };
    }

    const trustedBeforeRead = Boolean(this.tap.health().trusted);
    const startedAt = Date.now();
    const adapter = new TapStreamAdapter(turn.profile, preferRawContract);
    let deliveryFailed = false;
    const reconciler = new ResponseReconciler(
      this.config.readMode ?? 'auto',
      turn.mode,
      onDelta ? async (delta) => {
        try { await onDelta(delta); }
        catch (error) { deliveryFailed = true; throw error; }
      } : undefined,
      startedAt
    );

    let tapFailure: TapFailureReason | undefined;
    let matchedAt: number | undefined;
    let firstByteAt: number | undefined;
    let matched = false;
    let adapterEnded = false;
    let tapLastByteAt: number | undefined;
    let tapBytes = 0;
    // Independent completion channel. A valid correlated K2 frame may win
    // while the DOM observer is still polling (or while the CDP HTTP request
    // remains open). The DOM observer may also win when tap matching fails.
    let resolveTapWinner!: (value: { source: 'tap'; raw: string }) => void;
    const tapWinner = new Promise<{ source: 'tap'; raw: string }>((resolve) => {
      resolveTapWinner = resolve;
    });
    let tapSettleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTapSettle = (): void => {
      if (tapSettleTimer) clearTimeout(tapSettleTimer);
      tapSettleTimer = undefined;
    };
    const considerTapCompletion = (ended: boolean): void => {
      if (!preferRawContract || !matched || tapFailure || deliveryFailed || signal?.aborted) return;
      const raw = adapter.completedKAP2();
      if (!raw) return;
      clearTapSettle();
      if (ended) {
        resolveTapWinner({ source: 'tap', raw });
        return;
      }
      const lastByte = tapLastByteAt;
      const settleMs = Math.max(750, this.config.uiSettleMs);
      tapSettleTimer = setTimeout(() => {
        // No early completion from an intermediate K2/END token.
        if (signal?.aborted || tapFailure || !lastByte || tapLastByteAt !== lastByte
            || Date.now() - lastByte < settleMs) return;
        if (adapter.completedKAP2() === raw) resolveTapWinner({ source: 'tap', raw });
      }, settleMs);
      tapSettleTimer.unref?.();
    };

    const failTap = async (reason: TapFailureReason): Promise<void> => {
      if (!tapFailure) {
        tapFailure = reason;
        this.tap.recordFailure(reason);
      }
      await reconciler.fallback(reason);
    };

    const tapTask = (async () => {
      for await (const event of turn.events()) {
        if (event.type === 'matched') {
          matched = true;
          matchedAt = event.t;
          adapter.matchedResponse(event.url, event.method, event.contentType);
          logger.debug('ui.tap.matched', { provider_id: this.provider?.id ?? 'unknown', mode: turn.mode, since_start_ms: event.t - startedAt });
          continue;
        }
        if (event.type === 'chunk') {
          if (firstByteAt === undefined) firstByteAt = event.t;
          tapLastByteAt = event.t;
          tapBytes += event.bytes.byteLength;
          let deltas: string[];
          try {
            deltas = adapter.push(event.bytes);
          } catch {
            await failTap('decode_error');
            turn.cancel();
            continue;
          }
          for (const delta of deltas) await reconciler.tapDelta(delta);
          considerTapCompletion(false);
          continue;
        }
        if (event.type === 'end') {
          if (!event.ok) {
            await failTap('stream_aborted');
            continue;
          }
          let deltas: string[];
          try {
            deltas = adapter.end();
          } catch {
            await failTap('decode_error');
            continue;
          }
          adapterEnded = true;
          logger.debug('ui.tap.complete', { provider_id: this.provider?.id ?? 'unknown', bytes: tapBytes, text_chars: adapter.accumulatedText().length });
          for (const delta of deltas) await reconciler.tapDelta(delta);
          considerTapCompletion(true);
          continue;
        }
        logger.debug('ui.tap.fallback', { provider_id: this.provider?.id ?? 'unknown', reason: event.reason, bytes: tapBytes });
        await failTap(event.reason);
      }
    })();
    // Propagate consumer failures immediately: a rejected downstream write
    // must cancel the DOM observer, not wait for a coincidental DOM timeout.
    let rejectTapTask!: (error: unknown) => void;
    const tapTaskFailed = new Promise<never>((_resolve, reject) => {
      rejectTapTask = reject;
    });
    void tapTask.catch(rejectTapTask);

    const monitoring = new AbortController();
    let dom: UiResponseResult;
    let winnerSource: 'dom' | 'tap' = 'dom';
    try {
      const domTask = this.monitor(
        this.session,
        this.provider,
        this.config,
        baseline,
        sentPrompt,
        (delta) => reconciler.domDelta(delta),
        signal ? AbortSignal.any([signal, monitoring.signal]) : monitoring.signal,
        () => ({ ...(tapLastByteAt === undefined ? {} : { lastByteAt: tapLastByteAt }),
          receiving: matched && !adapterEnded && !tapFailure }),
        preferRawContract
      );
      // Race valid completions, not network transports. Neither observer
      // waits for the other to signal end; a failed tap simply leaves DOM
      // alive. Once a winner is selected we cancel only observation.
      const ready = await Promise.race([
        domTask.then(value => ({ source: 'dom' as const, value })),
        tapWinner,
        tapTaskFailed
      ]);
      winnerSource = ready.source;
      if (ready.source === 'tap') {
        logger.debug('ui.tap.independent_contract_complete', {
          provider_id: this.provider?.id ?? 'unknown', text_chars: ready.raw.length,
          trusted_before_read: trustedBeforeRead
        });
        dom = { text: ready.raw, deltas: [],
          firstDeltaMs: firstByteAt === undefined ? undefined : firstByteAt - startedAt,
          durationMs: Date.now() - startedAt };
      } else dom = ready.value;
    } catch (error) {
      monitoring.abort();
      turn.cancel();
      clearTapSettle();
      await tapTask.catch(() => undefined);
      // A DOM timeout must not silently manufacture a response, but a
      // strictly complete and correlated tap body survives DOM failure.
      const eligibleLegacy = preferRawContract && trustedBeforeRead
        && Boolean(turn.profile?.textMode) && turn.mode === 'active'
        && matched && adapterEnded && !tapFailure;
      const recovered = error instanceof UiTimeoutError && !signal?.aborted && !deliveryFailed && matched && !tapFailure
        ? (eligibleLegacy
          ? completedRawContract(adapter.accumulatedText(), adapter.accumulatedAlternativeText(), true)
          : adapter.completedKAP2())
        : undefined;
      if (recovered === undefined) throw error;
      winnerSource = 'tap';
      dom = { text: recovered, deltas: [], firstDeltaMs: firstByteAt === undefined
        ? undefined : firstByteAt - startedAt, durationMs: Date.now() - startedAt };
    } finally {
      monitoring.abort();
      clearTapSettle();
    }

    turn.cancel();
    await tapTask;
    if (!adapterEnded && winnerSource !== 'tap') {
      let deltas: string[] = [];
      try {
        deltas = adapter.end();
      } catch {
        await failTap('decode_error');
      }
      for (const delta of deltas) await reconciler.tapDelta(delta);
    }

    let canonicalText: string;
    try {
      canonicalText = winnerSource === 'tap' ? dom.text : selectContractResponseText(dom.text, adapter.accumulatedText(),
        preferRawContract && trustedBeforeRead && Boolean(turn.profile?.textMode) && turn.mode === 'active' && matched && adapterEnded && !tapFailure,
        adapter.accumulatedAlternativeText());
    } catch (error) {
      await failTap('verify_mismatch');
      throw error;
    }
    const rawSelected = canonicalText !== dom.text;
    let verified = false;
    if (matched && adapterEnded && !tapFailure && winnerSource === 'dom') {
      const candidate = adapter.verification(dom.text);
      if (candidate) {
        this.tap.recordVerified(candidate.profile);
        verified = true;
      } else if (adapter.accumulatedText() && !rawSelected) {
        await failTap(turn.profile ? 'verify_mismatch' : 'profile_mismatch');
      } else if (!rawSelected) {
        await failTap('profile_mismatch');
      }
    }

    const health = this.tap.health();
    const result = await reconciler.finalize(
      canonicalText,
      verified,
      Boolean(health.trusted)
    );
    const readDiagnostics: ReadDiagnostics = {
      ...result.diagnostics,
      source: winnerSource,
      ...(matchedAt !== undefined ? { tap_matched_ms: Math.max(0, matchedAt - startedAt) } : {}),
      ...(firstByteAt !== undefined ? { tap_first_byte_ms: Math.max(0, firstByteAt - startedAt) } : {})
    };

    return {
      ...dom,
      text: canonicalText,
      deltas: onDelta ? [] : result.deltas,
      firstDeltaMs: result.firstDeltaMs ?? dom.firstDeltaMs,
      readDiagnostics
    };
  }
}
