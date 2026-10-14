# Reverse Proxy 5.3.6 — capture KAP/2 after transcript virtualization

## Incident and root cause
The authenticated 2026-10-14 incident on 5.3.5 showed visible `K2/END` markers but no captured response. The proxy read a changing ChatGPT UI but could not establish freshness because the old DOM transcript was not present as a contiguous substring. The host received a transport `UiTimeoutError` instead of a parsed or repairable KAP reply.

## Change
- Recover a single fresh, delimited malformed KAP reply **only after a sufficiently long exact-tail match of the newly submitted prompt** in the current visible DOM. This accommodates virtualized conversations in which the previous page-text baseline disappears.
- Recognize the case where the web renderer collapses a delimited compact KAP/2 answer into one visible line. Such output enters the existing **host-owned contract repair** path, not the successful KAP parser or tool executor.
- Preserve strict `parseKAP` validation for valid completions, reject old candidates and candidate text copied from the prompt, and reject competing/missing markers.
- Add focused regressions for virtualized, collapsed and multiline malformed DOM responses and prior-response replay. No CDP tap is reenabled by default.

## Verification
CI for the initial fix branch passed TypeScript checks, automated unit tests, production build and Chromium integration. The 5.3.6 release requires a second CI pass against this versioned commit. Authenticated live ChatGPT/Gemini E2E remains **unverified** and must not be inferred from browser fixture tests.

## Installation
The standalone `install.sh` and `install.ps1` already select `stable` releases dynamically and `--ref main` for source installs. The root KITT installer selects a fixed reverse-proxy SHA in `ecosystem.release.json`; the root snapshot must be advanced to 0.15.30 after the proxy main update. No migration or protocol lock change is needed for other components.
