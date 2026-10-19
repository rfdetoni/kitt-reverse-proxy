# Reverse Proxy 5.4.10 — rich composer one-character mutation recovery

The 2026-10-19 ChatGPT-Web RE session failed after an existing `kitt_runtime` tool result: 1695 expected normalized composer characters vs 1696 observed. The provider response contract was valid, but the UI editor had mutated a short follow-up prompt.

- Apply one bounded DOM replacement and verify a stable, exact normalized editor draft even for prompts below 8 KiB (previously recovery only applied to >=8 KiB).
- Never keyboard-retype into a corrupted rich editor, and never submit when either the subsequent stability check or pre-send final integrity gate fails.
- Retain the existing long-prompt fail-closed diagnostic contract.
- Add dedicated 1695/1696-character tests for successful repair, persistent mutation and delayed controlled-editor reversion; ensure exactly one submit and zero keyboard replays.
- Update package.json and package-lock.json to 5.4.10; no dependency changes.

CI tests prove synthetic editor contract behavior; live authenticated ChatGPT-Web end-to-end and original host OS reproduction were not available. This does not alter independent Clean-Room host authorization.
