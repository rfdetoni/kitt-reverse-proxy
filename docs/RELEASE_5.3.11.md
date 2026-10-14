# Reverse Proxy 5.3.11 — T00 composer integrity and send recovery

The user observed that the T00 message was visible in the ChatGPT composer
but never sent. The incident logs confirm the planner returned 16,684 chars
before a 12,371-vs-12,374 normalized composer mismatch on T00. The proxy
raised `ui_automation_error` twice before dispatch and then reported a
still-generating UI on the third attempt. This is not KAP parsing or LLM
generation latency.

## Fix

- Recover rich-editor formatting drift for all prompts >= 8,192 chars using
  one direct content assignment and two delayed independent reads.
- Do not fall back to bulk keyboard insertion for multi-KiB prompts.
- Verify the draft again immediately before dispatching send.
- Keep the refusal to send corrupted drafts or invent user actions.
- Add regression tests for the +3 character mutation case and failed
  recovery without accidental sends.

## Validation

This release requires TS build, unit tests, Chromium integration and Docker
build to pass. A live authenticated ChatGPT Web retest remains necessary.
