import type { ChatExecutionOptions, ChatExecutionResult, ChatExecutor, JsonObject } from '../types.js';
import { telemetry } from '../util/telemetry.js';

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 30_000;
const EWMA_ALPHA = 0.2;

export class ProviderCircuitOpenError extends Error {
  constructor(
    public readonly provider: string,
    public readonly transport: ChatExecutor['transport'],
    public readonly retryAfterMs: number
  ) {
    super(`Circuit breaker aberto para ${provider}/${transport}. Tente novamente em ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = 'ProviderCircuitOpenError';
  }
}

function availabilityFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'UpstreamHttpError') {
    const status = Number((error as Error & { status?: unknown }).status);
    return status === 429 || status >= 500;
  }
  return new Set([
    'UiTimeoutError',
    'UpstreamRedirectError',
    'UpstreamResponseTooLargeError'
  ]).has(error.name);
}

function isRequestAborted(error: unknown): boolean {
  return error instanceof Error && ['RequestAbortedError', 'RequestDeadlineError'].includes(error.name);
}

export interface ResilienceSnapshot extends JsonObject {
  circuit: 'closed' | 'open' | 'half_open';
  consecutive_failures: number;
  failure_threshold: number;
  cooldown_ms: number;
  retry_after_ms: number;
  latency_ewma_ms: number | null;
  successes: number;
  failures: number;
}

export class ProviderCircuitState {
  consecutiveFailures = 0;
  openUntil = 0;
  halfOpenProbe = false;
  latencyEwmaMs: number | undefined = undefined;
  successes = 0;
  failures = 0;

}

export class ResilientChatExecutor implements ChatExecutor {
  readonly modelId: string;
  readonly transport: ChatExecutor['transport'];
  readonly reset?: () => Promise<void>;
  state = new ProviderCircuitState();
  shareState(state: ProviderCircuitState): void { this.state = state; }

  constructor(
    private readonly delegate: ChatExecutor,
    private readonly provider: string,
    private readonly failureThreshold = DEFAULT_FAILURE_THRESHOLD,
    private readonly cooldownMs = DEFAULT_COOLDOWN_MS
  ) {
    this.modelId = delegate.modelId;
    this.transport = delegate.transport;
    if (delegate.reset) this.reset = async () => delegate.reset!();
  }

  async execute(body: JsonObject, options?: ChatExecutionOptions): Promise<ChatExecutionResult> {
    const now = Date.now();
    if (this.state.openUntil > now) {
      telemetry.recordProviderEvent(this.provider, this.transport, 'circuit_reject');
      throw new ProviderCircuitOpenError(this.provider, this.transport, this.state.openUntil - now);
    }
    if (this.state.openUntil > 0) {
      if (this.state.halfOpenProbe) {
        telemetry.recordProviderEvent(this.provider, this.transport, 'circuit_reject');
        throw new ProviderCircuitOpenError(this.provider, this.transport, this.cooldownMs);
      }
      this.state.halfOpenProbe = true;
      telemetry.recordProviderEvent(this.provider, this.transport, 'half_open_probe');
    }

    const startedAt = Date.now();
    try {
      // A failed UI request must never reset the browser session implicitly. In the
      // UI transport, reset() navigates to the provider's new-chat URL and clears
      // conversation state, so using it as retry recovery silently opens a second
      // conversation. Propagate the failure and let the caller decide whether an
      // explicit session reset is appropriate.
      const result = await this.delegate.execute(body, options);
      this.recordSuccess(Date.now() - startedAt);
      return result;
    } catch (error) {
      if (isRequestAborted(error)) {
        if (this.state.halfOpenProbe) {
          this.state.halfOpenProbe = false;
          this.state.openUntil = Date.now() + Math.min(1_000, this.cooldownMs);
        }
        throw error;
      }
      // UiAutomationError means the provider was reachable but our browser
      // interaction failed. Treating it as provider unavailability can open the
      // circuit after repeated deterministic DOM failures and hide the real cause.
      if (availabilityFailure(error)) this.recordFailure();
      else this.recordReachable(Date.now() - startedAt);
      throw error;
    }
  }

  hasPendingToolCalls(): boolean {
    return this.delegate.hasPendingToolCalls?.() ?? false;
  }

  describe(): JsonObject {
    return {
      ...this.delegate.describe(),
      resilience: this.snapshot()
    };
  }

  snapshot(now = Date.now()): ResilienceSnapshot {
    const retryAfterMs = Math.max(0, this.state.openUntil - now);
    const circuit: ResilienceSnapshot['circuit'] = this.state.halfOpenProbe
      ? 'half_open'
      : retryAfterMs > 0
        ? 'open'
        : 'closed';
    return {
      circuit,
      consecutive_failures: this.state.consecutiveFailures,
      failure_threshold: this.failureThreshold,
      cooldown_ms: this.cooldownMs,
      retry_after_ms: retryAfterMs,
      latency_ewma_ms: this.state.latencyEwmaMs === undefined ? null : Math.round(this.state.latencyEwmaMs * 100) / 100,
      successes: this.state.successes,
      failures: this.state.failures
    };
  }

  private updateLatency(durationMs: number): void {
    const value = Math.max(0, durationMs);
    this.state.latencyEwmaMs = this.state.latencyEwmaMs === undefined
      ? value
      : (EWMA_ALPHA * value) + ((1 - EWMA_ALPHA) * this.state.latencyEwmaMs);
  }

  private recordSuccess(durationMs: number): void {
    const wasOpen = this.state.openUntil > 0 || this.state.halfOpenProbe;
    this.updateLatency(durationMs);
    this.state.successes += 1;
    this.state.consecutiveFailures = 0;
    this.state.openUntil = 0;
    this.state.halfOpenProbe = false;
    telemetry.recordProviderEvent(this.provider, this.transport, wasOpen ? 'circuit_close' : 'success');
  }

  private recordReachable(durationMs: number): void {
    this.updateLatency(durationMs);
    this.state.consecutiveFailures = 0;
    this.state.openUntil = 0;
    this.state.halfOpenProbe = false;
    telemetry.recordProviderEvent(this.provider, this.transport, 'reachable_error');
  }

  private recordFailure(): void {
    this.state.failures += 1;
    this.state.consecutiveFailures += 1;
    this.state.halfOpenProbe = false;
    telemetry.recordProviderEvent(this.provider, this.transport, 'failure');
    if (this.state.consecutiveFailures < this.failureThreshold) return;
    this.state.openUntil = Date.now() + this.cooldownMs;
    telemetry.recordProviderEvent(this.provider, this.transport, 'circuit_open');
  }
}
