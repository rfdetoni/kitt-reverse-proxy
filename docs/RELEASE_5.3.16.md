# Reverse Proxy 5.3.16 — current-turn DOM capture

The 2026-10-15 logs show successful plan capture followed by
`ui.response.capture_missing` on the first operational task: no assistant or
conversation-turn nodes, no fresh compact final, and no response delivered to
Agent CLI. The missing assistant response itself was not logged, so its exact
rendering cannot be reconstructed from those logs alone.

Two capture blind spots are now reproduced and fixed:

- A fresh tool action identical to a prompt example was discarded as an echo.
  A newly rendered submitted-prompt boundary now identifies the reply region
  before content-based exclusions. Baseline occurrence counts prevent sidebar
  changes from reusing an old prompt/reply; competing responses remain invalid.
- Mutation snapshots used only `textContent`, which loses `<br>` boundaries.
  The observer retains both rendered text and source indentation, within the
  existing size/sample caps. Layout reads occur only for complete KAP candidates.

A fresh flattened action surrounded by UI chrome can reach the existing host
repair path. This does not invent KAP fields, authorize tools, resend the
provider request, or change the Protocol/Agent wire contract.

Validation: both new Chromium regressions fail against main `e4fb7548` and pass
with the fix. Unit coverage includes prompt-only echoes, repeated actions,
old-page mutations, duplicate/malformed frames and competing actions. No
authenticated ChatGPT session was available for a live provider replay.

Package and npm lock metadata advance together to 5.3.16. KAP/2 SDK files and
dependency resolutions are unchanged.
