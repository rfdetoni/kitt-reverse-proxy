# Reverse Proxy 5.1.8 — Completed ChatGPT answer capture

## Evidence

In the 2026-10-13 18:42–18:48 UTC Windows API Observatory trace,
the proxy submitted exactly one 64,573-character prompt. Browser generation
was visible for approximately 178 seconds. The streaming control then
disappeared, while the DOM monitor still reported response_chars=0.
The proxy failed after another 180 seconds with ui_timeout. The CDP tap
had failed early with no_matching_request.

This was a completed-browser-response extraction failure, not an
insufficient deadline. Raising the 15-minute budget is not the fix.

## Corrections

- ChatGPT response selectors now include assistant-owned prose/preformatted
  content, including layouts with no .markdown element.
- After browser generation ends, the monitor scans the newest
  assistant-owned DOM message for a complete, strictly parsed KAP/1
  envelope. It does not scan the entire body, accept user messages, or
  blindly reuse previously completed assistant contracts.
- If extraction is still impossible 20 seconds after generation stopped,
  fail with a specific capture error, rather than waiting another three
  minutes. Log assistant container/sample/end-marker counts only, not
  the model's response.
- The passive CDP correlation no longer requires an entire 64 KiB prompt
  to appear contiguously inside one JSON string. For large prompts,
  three distinct bounded anchors (start, middle and end) must all match
  within the same decoded request. Existing origin, method, endpoint,
  response and stream verification remain in force. A bounded match
  window of 20 seconds applies to large prompts.
- Tests cover complete/incomplete, stale and contradictory assistant KAP
  candidates and a correlated POST with fragmented large prompt content.

## Validation/limitations

Code and unit tests cannot establish the current authenticated ChatGPT
Web DOM structure. Diagnostic `ui.response.capture_missing` and
`ui.tap.match_diagnostics` report aggregate counts to distinguish an
unknown assistant layout from a network request matching failure.
A live operator browser run remains necessary. There is no automatic
replay of a prompt already submitted to the ChatGPT Web interface.
