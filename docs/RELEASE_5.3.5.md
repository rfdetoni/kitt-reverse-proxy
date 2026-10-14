# Reverse Proxy 5.3.5 — recovering visible final KAP WebChat responses

## Evidence
In the 2026-10-14 13:48 logs, Proxy **5.3.4** confirmed a 63,593-character ChatGPT Web prompt, then polled the DOM for 284 seconds without capturing any usable response. The final probe reported `assistant_nodes=0`, `structural_turn_nodes=0`, `text_samples=2`, `visible_end_markers=1`; the Agent received `ui_timeout`. CDP tap was already disabled (`observed_tap=false`), so changing tap settings cannot resolve this fault.

## Fix
- Snapshot `document.body.innerText` before every user or repair request, not just `main` on the initial request.
- Inspect both main and body rendered text to recover responses in portals or UI layouts with stale role/class selectors.
- Preserve strict KAP/2 parsing as the **only successful early completion**. If a freshly appended, uniquely delimited frame has malformed structure or markdown-altered whitespace, allow it to reach the existing host-owned validation/repair path only after a stable 3.5-second observation and once generation is no longer running.
- Reject old/pre-submit text, copied KAP examples embedded in the submitted prompt, more than one frame, oversized frames, and absent required delimiters. No model text becomes host authorization.
- Expose bounded diagnostics `dom_samples`, `dom_end_markers`, `dom_fresh_visible_chars`, and `unparsed_fresh_candidate`, without logging the model reply or private DOM content.

## Compatibility, tests and limits
- Auto mode remains DOM-only for both ChatGPT and Gemini; explicit tap mode remains available for diagnostics.
- Preserve provider-side request and exactly-once host execution semantics. Never auto-replay a submitted prompt or force provider request aborts.
- Unit regression ensures stale page content is not accepted and a new malformed frame is isolated for repair. CI, TypeScript type check, Chromium integration and Docker build are release gates.
- This patch addresses two evidenced capture flaws; it is **not** yet validated against the authenticated live session that produced the incident. If the new diagnostics show no fresh DOM characters, inspect actual response placement, iframe/shadow root, or browser UI lifecycle instead of loosening KAP validation.

No benchmarks.
