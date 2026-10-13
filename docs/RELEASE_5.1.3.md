# Reverse Proxy 5.1.3 — WebChat composer reliability

Corrects the 2026-10-13 failure where a large KITT Agent task could
take roughly one minute to populate the ChatGPT Web composer and then
fail with an unexpected character count.

## Changes

- Do not rehydrate the current logical user turn as prior history when the
  Agent sends an expanded orchestration message ending with the same turn.
  Previous turns are retained; the current turn is submitted only once.
- Compare both rendered and underlying contenteditable text before treating
  rich-editor line layout differences as corrupted input.
- For inputs of at least 16,384 characters, use one bounded Playwright
  fill attempt and fail on integrity mismatch. Avoid repeated keyboard or
  DOM reinsertion, which can stall Chromium and duplicate content.
- Emit metadata-only composer-write timing and failure diagnostics.

## Verification

Focused tests cover wrapped turn de-duplication, preservation of previous
conversation, refusal of unrelated suffixes, and no keyboard replay of a
corrupted large draft. CI should run the existing TypeScript build/test gates.
Real authenticated provider submission must be smoke-tested separately; no
claim of live ChatGPT Web end-to-end validation is made here.

For the integrated KITT installer, use the edge channel to resolve component
main revisions. The release channel remains pinned to its own manifest.
