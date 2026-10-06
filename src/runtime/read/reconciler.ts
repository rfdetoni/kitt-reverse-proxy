import type { ChatExecutionOptions } from '../../types.js';
import type { ReadDiagnostics, TapFailureReason, TapTurnMode, UiReadMode } from './types.js';

export interface ReconcilerResult {
  deltas: string[];
  firstDeltaMs: number | undefined;
  diagnostics: ReadDiagnostics;
}

export class StreamMismatchError extends Error {
  constructor() { super('The final response diverged from the emitted stream; retrieve the canonical response before retrying.'); this.name = 'StreamMismatchError'; }
}

export class ResponseReconciler {
  private source: 'tap' | 'dom';
  private emitted = '';
  private domText = '';
  private tapText = '';
  private readonly deltas: string[] = [];
  private firstDeltaMs?: number;
  private fallbackReason?: TapFailureReason;
  private delivery: Promise<void> = Promise.resolve();

  constructor(
    private readonly readMode: UiReadMode,
    private readonly tapMode: TapTurnMode,
    private readonly onDelta: ChatExecutionOptions['onDelta'],
    private readonly startedAt = Date.now()
  ) {
    this.source = tapMode === 'active' ? 'tap' : 'dom';
  }

  tapDelta(delta: string): Promise<void> {
    return this.enqueue(async () => {
      if (!delta) return;
      this.tapText += delta;
      if (this.source === 'tap') await this.emit(delta);
    });
  }

  domDelta(delta: string): Promise<void> {
    return this.enqueue(async () => {
      if (!delta) return;
      this.domText += delta;
      if (this.source === 'dom') await this.flushDomSuffix();
    });
  }

  fallback(reason: TapFailureReason): Promise<void> {
    return this.enqueue(async () => {
      if (!this.fallbackReason) this.fallbackReason = reason;
      this.source = 'dom';
      await this.flushDomSuffix();
    });
  }

  async finalize(finalDomText: string, tapVerified: boolean, tapTrusted: boolean): Promise<ReconcilerResult> {
    await this.enqueue(async () => {
      this.domText = finalDomText;
      await this.flushDomSuffix(true);
    });
    await this.delivery;
    return {
      deltas: [...this.deltas],
      firstDeltaMs: this.firstDeltaMs,
      diagnostics: {
        mode: this.readMode,
        source: this.tapMode === 'active' && !this.fallbackReason ? 'tap' : 'dom',
        tap_mode: this.tapMode,
        ...(this.fallbackReason ? { fallback_reason: this.fallbackReason } : {}),
        tap_verified: tapVerified,
        tap_trusted: tapTrusted
      }
    };
  }

  tapAccumulatedText(): string {
    return this.tapText;
  }

  emittedText(): string {
    return this.emitted;
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.delivery.then(action, action);
    this.delivery = next.then(() => undefined, () => undefined);
    return next;
  }

  private async flushDomSuffix(final = false): Promise<void> {
    // The DOM can lag behind bytes already delivered by the tap.
    if (!final && this.emitted.startsWith(this.domText)) return;
    if (!this.domText) {
      if (this.emitted && this.onDelta) throw new StreamMismatchError();
      if (!this.onDelta) { this.emitted = ''; this.deltas.length = 0; }
      return;
    }
    if (!this.emitted) {
      await this.emit(this.domText);
      return;
    }
    if (!this.domText.startsWith(this.emitted)) {
      if (this.onDelta) throw new StreamMismatchError();
      this.emitted = ''; this.deltas.length = 0; await this.emit(this.domText); return;
    }
    const suffix = this.domText.slice(this.emitted.length);
    if (suffix) await this.emit(suffix);
  }

  private async emit(delta: string): Promise<void> {
    if (!delta) return;
    if (this.firstDeltaMs === undefined) this.firstDeltaMs = Math.max(0, Date.now() - this.startedAt);
    this.emitted += delta;
    if (this.onDelta) await this.onDelta(delta);
    else this.deltas.push(delta);
  }
}
