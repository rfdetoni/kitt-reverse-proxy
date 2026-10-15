# Reverse Proxy 5.3.17 — independent capture in auto mode

The new 2026-10-15 16:38 logs confirm the same task handoff failure on 5.3.16:
the plan is valid, the next request is accepted, but no assistant node or fresh
response is captured. The visible DOM growth is approximately the submitted
prompt length; `tap_mode` is disabled because auto mode explicitly bypassed
the passive network observer for ChatGPT and Gemini. The missing response
bytes are not present in those logs, so their exact provider encoding is unknown.

- `auto` now arms both existing readers. A complete, unique, strictly parsed
  KAP/2 answer from the current correlated browser request can finish without
  waiting for assistant markup. Explicit `dom` remains available.
- The stream decoder assembles append/replace text patches by declared target,
  including continuation values and bounded patch batches. Full message
  snapshots remain eligible for ordinary field extraction. A stateful `$.v`
  field is never learned as a generic reusable text source.
- Explicit non-assistant message branches and metadata cannot become KAP
  actions. Competing frames, malformed data, resource limits and cancellation
  remain enforced. The patch path is scoped to the current adapter/turn.
- Reader initialization logs observer mode and attachment state. All reads are
  passive: no private endpoint is fixed, no request is altered or replayed.

A real Chromium fixture leaves only the submitted prompt in DOM and returns
the KAP tool action in the correlated SSE response. It fails with the 5.3.16
auto-mode reader and passes with this change, asserting exactly one POST.
Other coverage checks DOM success after CDP attachment failure, incomplete and
competing responses, user echoes, patch continuations and metadata exclusion.

The authenticated user session was not accessible; a live provider replay and
full ecosystem installation remain outside this environment's validation.
No Agent CLI/Protocol contract or dependency resolution changes are needed.
Package and npm lock metadata advance together to 5.3.17.
