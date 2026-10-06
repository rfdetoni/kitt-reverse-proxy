# Reverse Proxy 4.9.12

Two reproduced delivery failures are corrected. A rejected streaming callback was classified as a decode error, then fallback generated an unhandled rejection while the DOM monitor was still pending. The reader now separates decoding from delivery, observes the tap task immediately, races fatal delivery against the monitor and aborts monitoring on failure. The original consumer error reaches the request boundary and does not demote a healthy extraction profile.

Fallback also treated an empty or lagging DOM as definitive stream divergence. Intermediate source prefixes now wait for the DOM to catch up, without replaying delivered bytes. Final responses still reject divergence, including truncation to a shorter prefix. Buffered canonical-response behavior is retained.

The new regressions failed on 4.9.11 and passed after correction. Local verification passed 189 tests, TypeScript checks and production build. The required Chromium CI fixture now exercises the actual hybrid reader against local HTTP/SSE and rendered DOM: the first turn earns profile trust, later turns preserve complete raw contracts despite damaged HTML, and a failed consumer cancels its monitor without a provider decode failure. The fixture also retains fragmented UTF-8 and LF/CRLF/CR coverage.

This changes delivery lifecycle handling, not the Agent/Protocol wire contract; consumer dependency locks are unchanged. Package and npm lock versions are 4.9.12. Authenticated provider sessions remain outside the fixture. Raw recovery still requires trust, full-prompt correlation, completion and valid unambiguous payloads; cancellation and manual intervention remain guarded.
