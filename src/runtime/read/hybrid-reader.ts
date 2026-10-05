import { selectContractResponseText } from './contract-text.js';
export { selectContractResponseText } from './contract-text.js';
import type { AppConfig, ChatExecutionOptions, JsonObject, LiveBrowserSession } from '../../types.js';
import type { ProviderPreset } from '../../providers/catalog.js';
import {
  awaitUiResponse,
  type UiResponseResult
} from '../ui-response-monitor.js';
import type { UiTextSnapshot } from '../ui-dom.js';
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
    private readonly config: AppConfig
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
      const dom = await awaitUiResponse(
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
    const reconciler = new ResponseReconciler(
      this.config.readMode ?? 'auto',
      turn.mode,
      onDelta,
      startedAt
    );

    let tapFailure: TapFailureReason | undefined;
    let matchedAt: number | undefined;
    let firstByteAt: number | undefined;
    let matched = false;
    let adapterEnded = false;

    const failTap = async (reason: TapFailureReason): Promise<void> => {
      if (!tapFailure) {
        tapFailure = reason;
        this.tap.recordFailure(reason);
      }
      await reconciler.fallback(reason);
    };

    const tapTask = (async () => {
      try {
        for await (const event of turn.events()) {
          if (event.type === 'matched') {
            matched = true;
            matchedAt = event.t;
            adapter.matchedResponse(event.url, event.method, event.contentType);
            continue;
          }
          if (event.type === 'chunk') {
            if (firstByteAt === undefined) firstByteAt = event.t;
            try {
              for (const delta of adapter.push(event.bytes)) await reconciler.tapDelta(delta);
            } catch {
              await failTap('decode_error');
              turn.cancel();
            }
            continue;
          }
          if (event.type === 'end') {
            if (!event.ok) {
              await failTap('stream_aborted');
              continue;
            }
            adapterEnded = true;
            try {
              for (const delta of adapter.end()) await reconciler.tapDelta(delta);
            } catch {
              await failTap('decode_error');
            }
            continue;
          }
          await failTap(event.reason);
        }
      } catch {
        await failTap('internal_error');
      }
    })();

    let dom: UiResponseResult;
    try {
      dom = await awaitUiResponse(
        this.session,
        this.provider,
        this.config,
        baseline,
        sentPrompt,
        (delta) => reconciler.domDelta(delta),
        signal
      );
    } catch (error) {
      turn.cancel();
      await tapTask.catch(() => undefined);
      throw error;
    }

    turn.cancel();
    await tapTask.catch(() => undefined);
    if (!adapterEnded) {
      try {
        for (const delta of adapter.end()) await reconciler.tapDelta(delta);
      } catch {
        await failTap('decode_error');
      }
    }

    let canonicalText: string;
    try {
      canonicalText = selectContractResponseText(dom.text, adapter.accumulatedText(),
        preferRawContract && trustedBeforeRead && Boolean(turn.profile) && turn.mode === 'active' && matched && adapterEnded && !tapFailure);
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
