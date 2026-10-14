# Reverse Proxy 5.3.2 — KAP negotiation and verified early logical completion

## Behavior
- Agent HTTP calls accept exact `X-Kitt-KAP: KAP/2`, acknowledge the selected
  version and publish `kap_negotiation` in `/v1/capabilities`.
  Unknown, empty, ambiguous or contradictory versions fail before UI submission.
  Requests lacking version metadata continue as KAP/2 for compatibility.
  Non-agent requests must not claim KAP negotiation.
- A pretrusted, correlated CDP tap exposing one strictly parsed KAP/2 envelope
  may end the logical response monitor **only if** browser generation has stopped
  and the current assistant-owned DOM turn agrees after a settle interval.
  The UI backend is not aborted, and tool execution/idempotency remain host-owned.
  Cold taps, competing envelopes, malformed payloads, prompt echoes and
  a missing assistant turn cannot bypass regular completion rules.

## Validation and limitations
- TypeScript strict check, proxy CI and focused tests for version rejection,
  K2 delimiter-only payloads, competing envelopes and semantic mismatches.
- No unverified frame-level early abort; the HTTP SSE stream remains bounded by
  its own complete response lifecycle. A screenshot/DOM-only fallback without
  previous trust cannot claim early CDP completion.
- Browser session reproduction is operator-specific and remains separate from
  CI simulated tests. No benchmarks.
