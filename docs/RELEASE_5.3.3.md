# Reverse Proxy 5.3.3 — first-complete CDP/DOM observation

## Incident
2026-10-14 ChatGPT Web 5.3.1, large KITT planning prompt:
`ui.tap.match_diagnostics` reported 5 POST bodies / 1 partial / 3
required anchors; DOM selector and structural fallback returned no
assistant node. After 210 seconds the proxy produced `ui_timeout`
despite a visible completed `K2/END` response.

## Changes
- Truly independent CDP and DOM completion channels. A valid current-turn
  KAP/2 response is selected by whichever observer finishes first.
  A quiet correlated tap can return before transport closure; DOM may
  return while tap is active or unmatched. The loser is cancelled without
  restarting the provider request. Neither source accepts `K2/END` alone.
- CDP shadow mode can recover a single validated answer-shaped KAP/2
  response before accumulating three DOM verification turns; permanent
  tap trust still requires independent verification.
- Segmented large prompt matching permits a single strong (>=160 chars)
  unique anchor only with a high-ranked, origin-allowed POST and no
  competing provider response candidates. Ambiguous partial matches
  fail closed. Exact matches retain priority.
- DOM reads newest markdown/answer descendants scoped to main when role
  attributes and conversation-turn selectors change; prompt echoes,
  baseline matches, user-owned turns and competing valid frames are refused.
- Regression tests cover CDP first/DOM stuck, DOM first/CDP absent,
  incomplete frames, segmented prompts and ambiguous requests.

## Safety and limitations
Completion selection changes no host authorization, tool call idempotency,
request ID replay policy or model output grammar. Ending the logical
observation cancels the passive watcher, **not** an ongoing provider request.
No blind retries for post-submission failures. The original incident
was reproduced from supplied logs, not from an authenticated browser in CI.
This is not proof every future ChatGPT UI redesign is automatically supported.
