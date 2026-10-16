# Reverse Proxy 5.4.7 — ChatGPT capture diagnostics and contract recovery

Based on operator logs from 2026-10-16 (Agent CLI and ChatGPT Web v5.4.5):

- Correlated CDP responses normally produced valid structured Agent actions.
  The final request was submitted successfully but yielded
  `no_matching_request` (three decoded POST bodies, zero matched anchors).
  DOM did not provide an unambiguous fresh assistant result.
- Explicit `ui_capture_unverified` (409) now identifies **uncorrelated
  CDP + unverified DOM** after a bounded post-generation grace interval.
  This error is recoverable via **explicit continue** in the Agent CLI,
  preserving task state; the provider request is never replayed automatically. Never
  trust old conversation JSON, auto-replay a possibly submitted request or
  silently promote content as the current action.
- The public `reasoning_summary` field is deterministically limited to two
  sentences **only after the entire response passes structural validation**.
  No tool, tool input, final result, approval or execution evidence is edited.
  An otherwise valid Agent action no longer triggers unnecessary browser
  repair turns solely for a redundant third sentence.
- Includes contract regression test asserting exact tool arguments preserved.

The **DeepSeek 1.1.0 provider** and its answer-only selector fix from 5.4.6
are retained, with no fallback to DeepThink panels.

Operator follow-up: keep `--log-content metadata` outside diagnostics;
check the authenticated Chromium profile and session after
`no_matching_request`, consider `/v1/kitt/reset` before a new request.
Observed browser RSS was about 1.51 GB versus a configured 768 MiB
admission threshold, which requires an operator resource-budget review.

Actual live authenticated ChatGPT/DeepSeek Web E2E is not validated in
GitHub CI; the exact DOM/POST rewrite in the operator's browser remains
unverified without a redacted capture fixture.
