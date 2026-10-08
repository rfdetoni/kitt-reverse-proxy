# kitt-reverse-proxy 5.0.2 — Filled draft without submission

The user reported Gemini keeping the filled draft, while clicking its send button manually submitted it. The selector cascade stopped at the last visible match, even when disabled. That match repeatedly masked an enabled button under the same or later selector, then the flow fell back to Enter. Rich editors may treat Enter as a newline and leave the draft unsent.

Send-control resolution now skips native and ARIA-disabled candidates and checks earlier matches and later selectors. Enabled probes use a short timeout so a detached control cannot consume the default locator timeout. The existing visibility-only resolver behavior for other callers is preserved.

The proxy logs whether it dispatches through a button or Enter, followed by its existing acceptance check. It still requires a cleared composer, generation or response evidence. It does not blindly resend after an uncertain click, and cancellation and attempt budgets remain unchanged. Agent contract v3, Protocol 0.10.0 and Agent 0.85.0 remain compatible. WebChat owns token limits.

The submission regression recreates a disabled candidate hiding an enabled control and verifies one click with no Enter fallback. The Chromium integration fixture exercises native and ARIA-disabled controls, English/Portuguese selectors, quoted multiline draft preservation and the existing ignored-click/detached-editor safeguards. Local Chromium download was unavailable; the real browser fixture is a required CI gate. No authenticated Gemini session was used.
