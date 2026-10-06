# Reverse Proxy 4.9.14

The new Gemini logs run 4.9.13 and show eleven valid contracts: a requested planning response followed by ten successful read/list calls. No syntax repair failed. The next request ended with no response bytes and a 180-second inactivity timeout. The logs do not record submission confirmation, so they cannot establish whether that final prompt was accepted by the live provider. The CDP tap remained untrusted, then its breaker disabled capture; this release does not claim to repair live Gemini network correlation.

## Corrections

`sendUiPrompt` previously returned successfully when the existing five-second submission confirmation window expired. A composer read failure was also converted to an empty string, incorrectly treated as acceptance. Both failures were reproduced before correction.

Submission now requires a cleared, connected and readable editor, an active generation control, or a changed assistant response relative to the pre-submit baseline. It re-resolves the editor after DOM replacement and bounds editor reads. Unconfirmed submission raises the existing `ui_automation_error`; there is no automatic resend or browser reset. The Agent's existing terminal-error policy already handles this code. A visible generation control prevents overwriting a user draft with another prompt.

The response monitor now uses the same provider-plus-semantic generation selectors as submission. Previously, a control such as `Stop output` could acknowledge sending while remaining invisible to the response watchdog, allowing a partial response to settle early. Inactivity and absolute budgets are unchanged. New diagnostic events record confirmation reason, elapsed time, draft/response lengths and streaming state without recording draft or answer contents.

## Validation and limits

Local verification passes 193 Proxy tests, TypeScript checks, production build and both dependency audits. A single necessary submission regression covers ignored click/Enter, unreadable composer, successful clearing and absence of duplicate attempts. Existing root installer/catalog tests and Protocol/Proxy schema parity remain compatible.

The required Chromium suite additionally exercises ignored submission, fast acceptance with a retained composer, draft preservation during generation, and a semantic-only generation control that must keep the monitor alive until the complete answer. This local HTML fixture does not authenticate with a live Gemini account. Publication requires the existing CI and browser gates. Missing live-provider response content is never inferred or replayed automatically.
