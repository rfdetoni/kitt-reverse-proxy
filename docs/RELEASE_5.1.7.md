# Reverse Proxy 5.1.7 — correlated network stream activity and KAP completion

The 2026-10-13 18:01–18:05 UTC incident showed the web UI generating,
but `ui.response.progress` kept `response_chars=0`. A structural
`deadline_ms=240000` sent by the Agent ended the request at four minutes.
That metadata must be fixed in the Agent; raising the proxy default alone
cannot override explicit smaller deadlines.

The proxy now uses correlated CDP bytes as a response-progress signal:
- The existing passive tap correlates browser POST content and response
  with the active request, without replaying private provider endpoints.
- Matching chunks update the DOM monitor's inactivity watchdog and
  diagnostics even if the browser UI does not expose assistant text yet.
- Unrelated DOM mutation, unmatched requests and merely passing time do
  not count as response bytes or successful completion.
- A complete, previously trusted correlated response carrying a strict
  `KITT/1 ... KITT/END` envelope can complete without waiting for an
  out-of-date DOM selector. Cold/untrusted streams still require DOM
  verification and cannot unilaterally trigger tool execution.
- Bounded absolute deadlines remain in force, preventing indefinite
  waiting on stuck/hostile pages; the request is never auto-replayed.
- Diagnostics log stream status, byte counts and timing, not response text.

Tests cover KAP raw recovery/trust restrictions and live CDP progress
without DOM changes. A live authenticated browser is still needed to
confirm whether the target session actually exposes tap chunks.
