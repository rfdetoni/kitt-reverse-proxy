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
    'UiAutomationError',
    'UpstreamRedirectError',
    'UpstreamResponseTooLargeError'
  ]).has(error.name);
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

export class ResilientChatExecutor implements ChatExecutor {
  readonly modelId: string;
  readonly transport: ChatExecutor['transport'];
  readonly reset?: () => Promise<void>;
  private consecutiveFailures = 0;
  private openUntil = 0;
  private halfOpenProbe = false;
  private latencyEwmaMs: number | undefined;
  private successes = 0;
  private failures = 0;

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
    if (this.openUntil > now) {
      telemetry.recordProviderEvent(this.provider, this.transport, 'circuit_reject');
      throw new ProviderCircuitOpenError(this.provider, this.transport, this.openUntil - now);
    }
    if (this.openUntil > 0) {
      if (this.halfOpenProbe) {
        telemetry.recordProviderEvent(this.provider, this.transport, 'circuit_reject');
        throw new ProviderCircuitOpenError(this.provider, this.transport, this.cooldownMs);
      }
      this.halfOpenProbe = true;
      telemetry.recordProviderEvent(this.provider, this.transport, 'half_open_probe');
    }

    const startedAt = Date.now();
    try {
      const result = await this.delegate.execute(body, options);
      this.recordSuccess(Date.now() - startedAt);
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'RequestAbortedError') {
        if (this.halfOpenProbe) {
          this.halfOpenProbe = false;
          this.openUntil = Date.now() + Math.min(1_000, this.cooldownMs);
        }
        throw error;
      }
      if (availabilityFailure(error)) this.recordFailure();
      else this.recordReachable(Date.now() - startedAt);
      throw error;
    }
  }

  describe(): JsonObject {
    return {
      ...this.delegate.describe(),
      resilience: this.snapshot()
    };
  }

  snapshot(now = Date.now()): ResilienceSnapshot {
    const retryAfterMs = Math.max(0, this.openUntil - now);
    const circuit: ResilienceSnapshot['circuit'] = this.halfOpenProbe
      ? 'half_open'
      : retryAfterMs > 0
        ? 'open'
        : 'closed';
    return {
      circuit,
      consecutive_failures: this.consecutiveFailures,
      failure_threshold: this.failureThreshold,
      cooldown_ms: this.cooldownMs,
      retry_after_ms: retryAfterMs,
      latency_ewma_ms: this.latencyEwmaMs === undefined ? null : Math.round(this.latencyEwmaMs * 100) / 100,
      successes: this.successes,
      failures: this.failures
    };
  }

  private updateLatency(durationMs: number): void {
    const value = Math.max(0, durationMs);
    this.latencyEwmaMs = this.latencyEwmaMs === undefined
      ? value
      : (EWMA_ALPHA * value) + ((1 - EWMA_ALPHA) * this.latencyEwmaMs);
  }

  private recordSuccess(durationMs: number): void {
    const wasOpen = this.openUntil > 0 || this.halfOpenProbe;
    this.updateLatency(durationMs);
    this.successes += 1;
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.halfOpenProbe = false;
    telemetry.recordProviderEvent(this.provider, this.transport, wasOpen ? 'circuit_close' : 'success');
  }

  private recordReachable(durationMs: number): void {
    this.updateLatency(durationMs);
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.halfOpenProbe = false;
    telemetry.recordProviderEvent(this.provider, this.transport, 'reachable_error');
  }

  private recordFailure(): void {
    this.failures += 1;
    this.consecutiveFailures += 1;
    this.halfOpenProbe = false;
    telemetry.recordProviderEvent(this.provider, this.transport, 'failure');
    if (this.consecutiveFailures < this.failureThreshold) return;
    this.openUntil = Date.now() + this.cooldownMs;
    telemetry.recordProviderEvent(this.provider, this.transport, 'circuit_open');
  }
}
