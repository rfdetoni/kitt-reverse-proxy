import type {
  TapCircuitState,
  TapFailureReason,
  TapHealthSnapshot,
  TapProfile,
  TapTurnMode,
  UiReadMode
} from './types.js';

function sameProfile(left: TapProfile | undefined, right: TapProfile): boolean {
  return Boolean(
    left
    && left.endpointOrigin === right.endpointOrigin
    && left.endpointPath === right.endpointPath
    && left.method === right.method
    && left.contentType === right.contentType
    && left.framing === right.framing
    && left.textPath === right.textPath
  );
}

export class TapHealthController {
  private attached = false;
  private profile?: TapProfile;
  private verifiedTurns = 0;
  private trusted = false;
  private consecutiveFailures = 0;
  private openUntil = 0;
  private halfOpenProbe = false;
  private lastFailure?: { reason: TapFailureReason; at: string };

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly requiredVerifiedTurns: number
  ) {}

  setAttached(value: boolean): void {
    this.attached = value;
  }

  currentProfile(): TapProfile | undefined {
    return this.profile ? { ...this.profile } : undefined;
  }

  turnMode(readMode: UiReadMode, now = Date.now()): { mode: TapTurnMode; reason?: TapFailureReason } {
    if (readMode === 'dom') return { mode: 'disabled', reason: 'tap_disabled' };
    if (!this.attached) return { mode: 'disabled', reason: 'attach_failed' };

    if (this.openUntil > now) return { mode: 'disabled', reason: 'circuit_open' };
    if (this.openUntil > 0 && now >= this.openUntil) {
      this.openUntil = 0;
      this.halfOpenProbe = true;
      return { mode: 'shadow' };
    }
    if (this.halfOpenProbe) return { mode: 'shadow' };

    return { mode: this.trusted && this.profile ? 'active' : 'shadow' };
  }

  recordVerified(candidate: TapProfile): void {
    if (sameProfile(this.profile, candidate)) {
      this.verifiedTurns += 1;
    } else {
      this.profile = { ...candidate };
      this.verifiedTurns = 1;
    }
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.halfOpenProbe = false;
    this.trusted = this.verifiedTurns >= this.requiredVerifiedTurns;
  }

  recordFailure(reason: TapFailureReason, now = Date.now()): void {
    this.lastFailure = { reason, at: new Date(now).toISOString() };
    this.consecutiveFailures += 1;
    this.verifiedTurns = 0;
    this.trusted = false;
    if (reason === 'verify_mismatch' || reason === 'profile_mismatch') this.profile = undefined;
    this.halfOpenProbe = false;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openUntil = now + this.cooldownMs;
    }
  }

  snapshot(now = Date.now()): TapHealthSnapshot {
    const retryAfterMs = Math.max(0, this.openUntil - now);
    let circuit: TapCircuitState = 'closed';
    if (this.halfOpenProbe) circuit = 'half_open';
    else if (retryAfterMs > 0) circuit = 'open';

    return {
      attached: this.attached,
      kind: this.attached ? 'cdp' : 'none',
      circuit,
      consecutive_failures: this.consecutiveFailures,
      verified_turns: this.verifiedTurns,
      required_verified_turns: this.requiredVerifiedTurns,
      learned: Boolean(this.profile),
      trusted: this.trusted,
      retry_after_ms: retryAfterMs,
      ...(this.lastFailure
        ? { last_failure: { reason: this.lastFailure.reason, at: this.lastFailure.at } }
        : {})
    };
  }
}
