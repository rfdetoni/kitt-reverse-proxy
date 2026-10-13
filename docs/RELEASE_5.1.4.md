# Release 5.1.4 — Real editor validation and native textarea input

## Reproduction (October 13, 2026)
A 64,573-character ChatGPT Web prompt was routed to the generic `textarea`
selector. In 43 seconds, `fill()` failed, the editor was unreadable, and no
provider response was obtained (`actual_chars=0`, `fill_failed=true`).

## Fix
- Always validate the real selected DOM element is connected and editable,
  instead of accepting a field merely because its CSS selector includes
  `textarea` or `contenteditable`.
- For native textareas/inputs with at least 16 KiB of content, use the
  element's native value setter and one input/change event. This avoids a
  large Playwright `fill()` and keyboard replay. Other rich editors retain
  the existing bounded `fill()` path.
- Read back the content and verify it again after 100 ms to avoid submitting
  a transient React-controlled value that will be discarded by re-rendering.
- Report the selected insertion strategy, duration, error type and length
  without disclosing the submitted text.
- Retain strict refusal to dispatch a message if the editor does not contain
  the expected prompt.

## Verification
The regression suite includes a 65 KiB native textarea and keeps the existing
mismatch rejection test. Unit tests verify the mocked DOM interaction; a live
authenticated ChatGPT Web smoke test is still required before claiming that
provider-specific behavior is fully repaired.
