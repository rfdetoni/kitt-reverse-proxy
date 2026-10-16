# Reverse Proxy 5.4.9 — DeepSeek 1.2.1 stopped-answer footer

Operator screenshot (2026-10-16) shows a DeepSeek reply marked **"Parado"**
with **"Servidor está temporariamente indisponível"**, and a
**"Continuar"** button in the response footer. Manual click resumed the
same generation. The screenshot is visual evidence, not an inspected HTML DOM.

- Locate exact generation-continuation labels on native buttons or
  `role="button"` controls in a single current assistant message card, including
  a footer sibling up to ten nested wrappers below the app main node.
- Reject global buttons, dialogs, forms, assistant-produced Markdown controls,
  user messages, multiple candidates and misleading authorization labels.
- Retain the previous one-click-per-prompt rule, no prompt replay, and
  prohibition on accepting pre-click partial JSON as a completed action.
- If the assistant card contains the stopped + server-unavailable error state
  but the continuation control cannot be matched safely, report
  **manual intervention required**, not a successful final response.
- Add a screenshot-shaped synthetic DOM fixture with seven wrapper levels,
  hidden-authorization-label rejection and absent-footer fail-closed behavior.
- Reverse Proxy `package.json` and `package-lock.json` bumped to **5.4.9**;
  DeepSeek plugin to **1.2.1**.

Live authenticated DeepSeek DOM behavior must still be tested on the
operator's browser. GitHub Chromium tests cannot verify the exact upstream
markup from the provided screenshot.

## Contract resilience from 2026-10-16 logs

Two operator logs (Agent CLI and DeepSeek Reverse Proxy 5.4.8) showed 72 contract validations: 55 valid and 17 invalid; seven requests exited with `agent_contract_invalid`. Failures were mainly malformed/incomplete JSON or ambiguous repairs. The browser also reported an RSS warning (934 MB above 805 MB configured limit).

To reduce amplification without bypassing validation:

- Serialization repair uses a dedicated **serializer-only system instruction**, rather than inviting execution or re-planning.
- Source task is included as a bounded 1,200-character **untrusted excerpt** plus its SHA-256, not the entire roughly 60 KiB original mission. Host owns the original context; the candidate remains the repair source.
- Only the selected already-declared tool schema (when identifiable) is sent; otherwise tool **names** are supplied as hints, not capabilities.
- Identical malformed responses wrapped in code fences no longer consume an extra retry. Recovery remains bounded and fail-closed.
- Existing strict checks still reject changed stable fields, competing JSON interpretations, unknown tool calls or unauthorized data. No model can grant permissions.
- Regression tests cover large task-context trimming and non-progressing fenced repairs.

WebChat live DOM and upstream model behavior cannot be proven by synthetic/Chromium CI alone.
