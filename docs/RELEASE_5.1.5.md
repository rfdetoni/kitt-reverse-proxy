# Reverse Proxy 5.1.5 — Bounded contenteditable recovery

The ChatGPT Web composer selected in the October 13 incident was
`div[role=textbox,contenteditable=true]`, not a native textarea.
A roughly 64 KiB prompt was modified in the editable DOM during the
browser fill, and strict validation correctly refused to send it.

- After one failed large rich-editor fill verification, attempt a single
  non-typing DOM replacement plus input event.
- Verify the exact normalized text twice after editor reconciliation.
- Never submit text that fails either check and never repeat a large
  keyboard insertion.
- Keep the native textarea insertion introduced in 5.1.4, and update
  its test to use the DOM payload contract.
- Add a focused rich-editor regression test.

This change is a fail-closed recovery path, not a guarantee that a
provider-controlled rich editor accepts programmatic insertion in every
browser session. Live authenticated ChatGPT Web validation is still needed.
