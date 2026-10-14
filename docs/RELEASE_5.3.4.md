# Reverse Proxy 5.3.4 — DOM-first recovery for ChatGPT and Gemini

## Cause and response
The October 14 authenticated WebChat incident occurred even on Reverse Proxy
5.3.3. A 2.47 MB CDP tap stream terminated as `stream_aborted`, and
assistant role/turn selectors did not find rendered KAP/2 text. Gemini Web
could produce a repaired KAP result but the client still did not receive
the completed final frame.

## Behavior
- For `chatgpt` and `gemini` with `readMode=auto`, CDP tap capture
  is fully disabled (no CDP initialization or arming). The DOM reader is
  authoritative. `--read-mode dom` forces DOM-only for any UI provider;
  `--read-mode tap` is an explicit diagnostic opt-in.
- DOM observation works with model-response, current reply markup and a
  bounded visible conversation fallback if role selectors fail.
- The model result must be a *complete structurally valid* KAP envelope,
  unchanged and unique after excluding pre-submit visible content, the
  submitted prompt and prior assistant frames. A bare `K2/END`, an
  unfinished newer frame or multiple competing valid frames does not
  finish a turn. Results settle before the logical observer closes.
- Both ChatGPT and Gemini get this strict DOM-completion path. A stable but
  invalid KAP response is returned after an extended 3.5s settle period to
  the existing Agent-contract validation/repair workflow; invalid frames
  are never promoted to tool calls or treated as successful early completion.
- No browser request replay, permission bypass, host authorization
  changes or forced cancellation of upstream model generation.

## Validation
- Tests explicitly prevent any CDP connection in auto mode on both
  providers; explicit tap mode keeps its prior coverage.
- Rendered KAP extraction tests reject prior-frame reuse, prompt echo,
  incomplete frames and ambiguous completions.
- TypeScript, unit tests and Docker build must pass before integration.
- Authenticated production browser behavior cannot be proved by mocked
  DOM fixtures; operator replay remains a separate acceptance check.

No benchmarks.
