# Reverse Proxy 5.4.8 — DeepSeek 1.2.0 paused generation

Operator observation: DeepSeek Web exposed a **Continue** button while writing a
response. Manually pressing it resumed the same answer successfully.
The 2026-10-16 logs show intermittent truncated JSON and repair attempts,
but do **not** contain a DOM snapshot proving which exact turn had that button.

- Observe only a *fresh* final-answer DOM node selected against the pre-submit
  baseline (never Thinking text, the prompt or old history).
- In `chat.deepseek.com`, locate an exact generation-continuation label
  (`Continue`, `Continue generating`, `Continuar`, etc.) only inside the
  **same** assistant card, never a page-wide button or a parent thread that
  contains multiple answer cards.
- Click once per submitted prompt without resending the prompt. Continue
  watching the same assistant answer until new text arrives; never emit the
  pre-click partial JSON frame as complete.
- A second pause, disabled button, UI race or missing post-continue progress
  requires the human operator. Login, consent, approval and arbitrary dialogs
  are excluded and never auto-confirmed.
- Synthetic DOM tests cover exact labels, disabled controls, origin, multiple
  matches, stale messages and single-click behavior. No live authenticated
  DeepSeek Web DOM E2E is claimed by CI.

Unrelated symptoms in uploaded Agent log, including PolicyEngine denying
`run_command`, remain host authorization boundaries and must not be
circumvented by a WebChat continuation feature.

Reverse Proxy `package.json` and `package-lock.json` both bump to 5.4.8.
