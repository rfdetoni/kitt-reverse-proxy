# Reverse Proxy 5.3.1 — ChatGPT long-turn capture hardening

The 2026-10-13 diagnostic trace confirmed a 64,048-character prompt was
successfully submitted while CDP reported `partial_matches=1` out of
3 anchors, and the prior assistant selector scan found zero role-labeled
assistant nodes after generation stopped.

## Changes
- CDP correlation now joins adjacent text fragments inside a single
  request array before matching the **same strict three anchors**.
  It never accepts a match based only on a single partial anchor.
- A finished ChatGPT response can be recovered from the **newest
  conversation turn** with an assistant-style markdown descendant when
  role attributes change, rejecting explicitly user-tagged elements,
  previously seen text, the submitted prompt, malformed contracts and
  ambiguous competing envelopes. It does not read arbitrary body text.
- Missing-capture telemetry counts structural conversation turns
  without logging user/model content.
- Regression tests exercise split long prompts, stale/competing KAP/2
  payloads and a role-less response container.

## Evidence and limits
CI TypeScript build/tests validate the new deterministic cases. The
original operator session cannot be replayed in CI because it depends
on a logged-in interactive ChatGPT Web session and site-specific markup.
This release **does not claim a successful production reproduction**
of that 2026-10-13 incident. If it recurs, use sanitized
`ui.tap.match_diagnostics` and `ui.response.capture_missing` logs
to determine whether the failure is correlation or DOM provenance.
