import type { JsonObject } from '../../types.js';

export type UiReadMode = 'auto' | 'dom' | 'tap';
export type TapTurnMode = 'disabled' | 'shadow' | 'active';
export type TapCircuitState = 'closed' | 'open' | 'half_open';

export type TapFailureReason =
  | 'tap_disabled'
  | 'attach_failed'
  | 'no_matching_request'
  | 'first_byte_timeout'
  | 'stall'
  | 'decode_error'
  | 'profile_mismatch'
  | 'stream_aborted'
  | 'verify_mismatch'
  | 'circuit_open'
  | 'internal_error';

export type TapFraming = 'sse' | 'ndjson' | 'framed';

export interface TapProfile {
  endpointOrigin: string;
  endpointPath: string;
  method: string;
  contentType: string;
  framing: TapFraming;
  textPath: string;
  textMode?: 'delta' | 'snapshot';
}

export interface TapHealthSnapshot extends JsonObject {
  attached: boolean;
  kind: 'cdp' | 'none';
  circuit: TapCircuitState;
  consecutive_failures: number;
  verified_turns: number;
  required_verified_turns: number;
  learned: boolean;
  trusted: boolean;
  retry_after_ms: number;
  last_failure?: JsonObject;
}

export type TapEvent =
  | {
      type: 'matched';
      requestId: string;
      url: string;
      method: string;
      contentType: string;
      t: number;
    }
  | { type: 'chunk'; bytes: Uint8Array; t: number }
  | { type: 'end'; ok: boolean; t: number }
  | { type: 'error'; reason: TapFailureReason; detail?: string };

export interface TapTurn {
  readonly mode: TapTurnMode;
  readonly profile?: TapProfile;
  events(): AsyncIterable<TapEvent>;
  cancel(): void;
}

export interface TapVerificationCandidate {
  profile: TapProfile;
  text: string;
}

export interface ReadDiagnostics extends JsonObject {
  mode: UiReadMode;
  source: 'dom' | 'tap';
  tap_mode: TapTurnMode;
  fallback_reason?: string;
  tap_verified?: boolean;
  tap_trusted?: boolean;
  tap_matched_ms?: number;
  tap_first_byte_ms?: number;
}
