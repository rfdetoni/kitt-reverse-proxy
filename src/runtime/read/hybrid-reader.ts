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
import { abortableSleep } from '../cancellation.js';
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

  constructor(
    private readonly session: LiveBrowserSession,
    private readonly provider: ProviderPreset,
    private readonly config: AppConfig,
    private readonly monitor: typeof awaitUiResponse = awaitUiResponse
  ) {
    this.tap = new CdpStreamTap(session, provider, config);
  }

  async initialize(): Promise<void> {
    await this.tap.initialize();
  }

  arm(prompt: string): void {
    this.pending?.cancel();
    this.pending = this.tap.arm(prompt);
  }

  cancelPending(): void {
    this.pending?.cancel();
    this.pending = undefined;
  }

  async reset(): Promise<void> {
    this.cancelPending();
    await this.tap.reconnect();
  }

  describe(): JsonObject {
    return {
      mode: this.config.readMode ?? 'auto',
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

    if (!turn || turn.mode === 'disabled') {
      const dom = await this.monitor(
        this.session,
        this.provider,
        this.config,
        baseline,
        sentPrompt,
        onDelta,
        signal
      );
      return {
        ...dom,
        readDiagnostics: {
          mode: this.config.readMode ?? 'auto',
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
          continue;
        }
        logger.debug('ui.tap.fallback', { provider_id: this.provider?.id ?? 'unknown', reason: event.reason, bytes: tapBytes });
        await failTap(event.reason);
      }
    })();
    // Observe failures immediately, even if the monitor throws synchronously.
    void tapTask.catch(() => undefined);

    const monitoring = new AbortController();
    let dom: UiResponseResult;
    try {
      const domTask = this.monitor(
        this.session,
        this.provider,
        this.config,
        baseline,
        sentPrompt,
        (delta) => reconciler.domDelta(delta),
        signal ? AbortSignal.any([signal, monitoring.signal]) : monitoring.signal,
        () => {
          const eligible = preferRawContract && trustedBeforeRead
            && Boolean(turn.profile?.textMode) && turn.mode === 'active'
            && matched && !tapFailure;
          const text = adapter.accumulatedText();
          const completedContract = eligible && text.trimStart().startsWith('K2 ')
            ? completedRawContract(text, adapter.accumulatedAlternativeText(), true)
            : undefined;
          return {
            ...(tapLastByteAt === undefined ? {} : { lastByteAt: tapLastByteAt }),
            receiving: matched && !adapterEnded && !tapFailure,
            ...(completedContract === undefined ? {} : { completedContract })
          };
        }
      );
      // Once the CDP request has completed, a previously trusted, strictly
      // validated KAP/1 stream can finish without waiting for a broken DOM
      // assistant selector. Cold/unverified taps still require DOM evidence.
      const tapCompleted = tapTask.then(() => completedRawContract(
        adapter.accumulatedText(),
        adapter.accumulatedAlternativeText(),
        preferRawContract && trustedBeforeRead && Boolean(turn.profile?.textMode)
          && turn.mode === 'active' && matched && adapterEnded && !tapFailure
      ));
      const tapReady = (async (): Promise<
        { source: 'dom'; value: UiResponseResult } | { source: 'tap'; raw: string }
      > => {
        const raw = await tapCompleted;
        if (raw === undefined) return { source: 'dom', value: await domTask };
        // Allow DOM to settle and surface intervention/consumer errors before
        // choosing the already validated CDP completion. No blind replay.
        return await Promise.race([
          domTask.then(value => ({ source: 'dom' as const, value })),
          abortableSleep(1_500, signal).then(() => ({ source: 'tap' as const, raw }))
        ]);
      })();
      const ready = await Promise.race([
        domTask.then(value => ({ source: 'dom' as const, value })),
        tapReady
      ]);
      if (ready.source === 'tap') {
        logger.debug('ui.tap.raw_contract_recovered', {
          provider_id: this.provider?.id ?? 'unknown', text_chars: ready.raw.length
        });
        dom = { text: ready.raw, deltas: [], firstDeltaMs: firstByteAt === undefined
          ? undefined : firstByteAt - startedAt, durationMs: Date.now() - startedAt };
      } else dom = ready.value;
    } catch (error) {
      monitoring.abort();
      turn.cancel();
      await tapTask.catch(() => undefined);
      const recovered = error instanceof UiTimeoutError && !signal?.aborted && !deliveryFailed
        ? completedRawContract(adapter.accumulatedText(), adapter.accumulatedAlternativeText(),
          preferRawContract && trustedBeforeRead && Boolean(turn.profile?.textMode) && turn.mode === 'active' && matched && adapterEnded && !tapFailure)
        : undefined;
      if (recovered === undefined) throw error;
      dom = { text: '', deltas: [], firstDeltaMs: undefined, durationMs: Math.max(0, Date.now() - startedAt) };
    } finally {
      monitoring.abort();
    }

    turn.cancel();
    await tapTask;
    if (!adapterEnded) {
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
      canonicalText = selectContractResponseText(dom.text, adapter.accumulatedText(),
        preferRawContract && trustedBeforeRead && Boolean(turn.profile?.textMode) && turn.mode === 'active' && matched && adapterEnded && !tapFailure,
        adapter.accumulatedAlternativeText());
    } catch (error) {
      await failTap('verify_mismatch');
      throw error;
    }
    const rawSelected = canonicalText !== dom.text;
    let verified = false;
    if (matched && !tapFailure) {
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
