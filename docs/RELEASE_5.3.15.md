# Reverse Proxy 5.3.15 — KAP/2 operational DOM capture

## Fix
- Capture bounded `K2 T`, `K2 F`, `K2 W` and `K2 Q` envelopes in the
  mutation observer. Previously only `K2 F` was recognized there.
- Keep stale-response rejection, prompt echo exclusion, strict host-side
  KAP/2 parsing, size bounds and the existing timeout behavior.

## Evidence and limits
15 October 2026 logs show valid planning `K2 F` followed by three
`ui_timeout` failures on the first operational turn: zero assistant-role
nodes and DOM-only capture. Regression tests cover tool-action selection and
old/echoed/competing replies. These static tests cannot prove that ChatGPT Web
rendered a reply in that specific session; an authenticated UI E2E is needed.

## Validation
Run `npm ci && npm run verify` with Node.js >=24 and verify an authenticated
`K2 T kitt_runtime` turn before treating the incident as fully resolved.
